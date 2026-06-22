import type {
    ComputedRef,
    Ref,
} from 'vue';
import { delay } from 'es-toolkit/promise';
import { BrowserLogger } from '@app/utils/browserLogger';
import type {
    IPageRange,
    IScrollSnapshot,
    PDFDocumentProxy,
    TFitMode,
    TPdfViewMode,
    TZoomMode,
} from '@app/types/pdf';
import type {
    ICurrentPageSyncOptions,
    IResizeAnchorContext,
} from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerCurrentPageSync';
import type { IBuildResizeAnchorContextOptions } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerResizeLifecycle';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';
import type { IZoomViewportAnchor } from '@app/modules/pdf-viewer/runtime/viewport/pdfViewerViewportTypes';
import { shouldPreserveExistingRerenderContent } from '@app/modules/pdf-viewer/runtime/rerender-strategy/shouldPreserveExistingRerenderContent';
import { getPageRowBoundsForViewMode } from '@app/modules/pdf-viewer/engine/pdf-page-layout/getPageRowBoundsForViewMode';

const ZOOM_QUEUE_LOG_THROTTLE_MS = 420;
const ZOOM_CHANGE_MAX_CANVAS_PIXELS = 14_000_000;
const ZOOM_CHANGE_SETTLE_CLAMP_SCALE_THRESHOLD = 0.98;
const ZOOM_GESTURE_CHANGE_SOURCE = 'zoom-gesture-change';
const CURRENT_PAGE_FIT_RERENDER_SETTLE_MS = 80;
const CURRENT_PAGE_FIT_CANCEL_SETTLE_MS = 150;
const FIT_HEIGHT_PRE_RENDER_SNAP_MAX_TICKS = 4;

type TFitRerenderTransitionOwner = 'current-page' | 'paged-target';

interface IUsePdfViewerRerenderCoordinatorOptions {
    viewerContainer: Ref<HTMLElement | null>;
    pdfDocument: Ref<PDFDocumentProxy | null>;
    isLoading: Ref<boolean>;
    numPages: Ref<number>;
    currentPage: Ref<number>;
    pagedNavigationTargetPage?: Readonly<Ref<number | null>> | undefined;
    visibleRange: Ref<IPageRange>;
    zoom: ComputedRef<number>;
    zoomMode?: ComputedRef<TZoomMode> | undefined;
    fitMode: ComputedRef<TFitMode>;
    viewMode: ComputedRef<TPdfViewMode>;
    isResizing: ComputedRef<boolean>;
    continuousScroll: ComputedRef<boolean>;
    getVisibleRange: () => IPageRange;
    reRenderAllVisiblePages: (
        getVisibleRange: () => IPageRange,
        options?: {
            preserveExistingPages?: boolean;
            anchorSnapshot?: IScrollSnapshot | null;
            disableHorizontalAnchorRestore?: boolean;
            disableVerticalAnchorRestore?: boolean;
            disablePageAnchorRestore?: boolean;
            rerenderSource?: string;
            renderBufferOverride?: number | undefined;
            maxCanvasPixelsOverride?: number | undefined;
        },
    ) => Promise<void>;
    isPageRendered: (page: number) => boolean;
    summarizeViewerMetricsForLog: (container: HTMLElement | null) => unknown;
    summarizeVisiblePageSnapshotForLog: (container: HTMLElement | null) => unknown;
    syncCurrentPageFromViewport: (options?: ICurrentPageSyncOptions) => Promise<void>;
    markLowResZoomRerenderUsed: () => void;
    buildResizeAnchorContext: (options?: IBuildResizeAnchorContextOptions) => IResizeAnchorContext;
    scheduleEndResizeTransition: (
        token: number,
        reason: string,
        page: number | null,
    ) => void;
    enqueueZoomSync: (syncOptions: ICurrentPageSyncOptions) => void;
    scheduleResizeAwareRerender: (
        stage: string,
        syncOptions?: ICurrentPageSyncOptions,
    ) => void;
    cancelInFlightPageRenders?: (() => void) | undefined;
    /**
     * Hydrates the target row's real dimensions before fit scale recomputes.
     *
     * Fit-height scale is based on the current page's measured
     * height. If we compute while the last page is still using fallback
     * document metrics, both the skeleton and the eventual canvas are sized
     * for the wrong page; the Girgas repro exposed that as an infinite-looking
     * skeleton after a rapid jump to page 928.
     */
    ensurePageMetricsInRange?: ((startPage: number, endPage: number) => Promise<boolean>) | undefined;
    computeFitWidthScale: (
        container: HTMLElement | null,
        options?: { page?: number | null | undefined },
    ) => boolean;
    syncHorizontalScrollForZoomMode?: (() => boolean) | undefined;
    setupPagePlaceholders: () => void;
    scrollToPage: (pageNumber: number, options?: IScrollToPageOptions) => unknown;
    getMostVisiblePage: (container: HTMLElement | null, numPages: number) => number;
    resetContinuousScrollState: () => void;
    cancelDestinationNavigationTarget?: (() => void) | undefined;
    resetZoomRerenderQueueState: (reason: string) => void;
    getUserViewportInteractionEpoch?: (() => number) | undefined;
    consumeZoomViewportAnchor?: (() => IZoomViewportAnchor | null) | undefined;
    beginResizeTransition: (source: string, anchorPage: number | null) => number;
    consumeSuppressedZoomRerender?: ((nextZoom: number) => boolean) | undefined;
    /**
     * Marks the brief window where current-page fit rerendering owns the row.
     *
     * The paged buffer renderer normally keeps neighboring pages warm, but
     * while fit-height/fit-width navigation is cancelling stale PDF.js tasks
     * and force-rendering the new current page, another buffer render can
     * restart the same target page and starve the authoritative render.
     */
    setCurrentPageFitRerenderTransitionActive?: ((active: boolean) => void) | undefined;
}

export const usePdfViewerRerenderCoordinator = (options: IUsePdfViewerRerenderCoordinatorOptions) => {
    const {
        viewerContainer,
        pdfDocument,
        isLoading,
        numPages,
        currentPage,
        pagedNavigationTargetPage,
        visibleRange,
        zoom,
        zoomMode,
        fitMode,
        viewMode,
        isResizing,
        continuousScroll,
        getVisibleRange,
        reRenderAllVisiblePages,
        isPageRendered,
        summarizeViewerMetricsForLog,
        summarizeVisiblePageSnapshotForLog,
        syncCurrentPageFromViewport,
        markLowResZoomRerenderUsed,
        buildResizeAnchorContext,
        scheduleEndResizeTransition,
        enqueueZoomSync,
        scheduleResizeAwareRerender,
        cancelInFlightPageRenders,
        ensurePageMetricsInRange,
        computeFitWidthScale,
        syncHorizontalScrollForZoomMode,
        setupPagePlaceholders,
        scrollToPage,
        getMostVisiblePage,
        resetContinuousScrollState,
        cancelDestinationNavigationTarget,
        resetZoomRerenderQueueState,
        getUserViewportInteractionEpoch,
        consumeZoomViewportAnchor,
        beginResizeTransition,
        consumeSuppressedZoomRerender,
        setCurrentPageFitRerenderTransitionActive,
    } = options;

    let reRenderSyncRunId = 0;
    let fitModeRunId = 0;
    let currentPageFitRerenderRunId = 0;
    let pagedTargetFitRerenderRunId = 0;
    let viewModeRunId = 0;
    let continuousScrollRunId = 0;
    let resizeSettleRunId = 0;
    let isCurrentPageFitRerenderTransitionMarkedActive = false;
    let nextFitRerenderTransitionToken = 0;
    const activeFitRerenderTransitionOwners = new Map<number, TFitRerenderTransitionOwner>();

    function isViewerAsyncRunActive(
        runId: number,
        activeRunId: number,
        document: PDFDocumentProxy | null,
    ) {
        return runId === activeRunId
            && document !== null
            && pdfDocument.value === document
            && !isLoading.value;
    }

    function isFitWidthZoomModeActive() {
        return zoomMode
            ? zoomMode.value === 'fit-width'
            : fitMode.value === 'width';
    }

    function isFitHeightZoomModeActive() {
        return zoomMode
            ? zoomMode.value === 'fit-height'
            : fitMode.value === 'height';
    }

    function shouldDisableHorizontalAnchorRestore() {
        if (!isFitWidthZoomModeActive()) {
            return false;
        }
        return syncHorizontalScrollForZoomMode?.() ?? true;
    }

    function syncHorizontalScrollAfterLayoutUpdate() {
        syncHorizontalScrollForZoomMode?.();
    }

    function getCurrentUserViewportInteractionEpoch() {
        const epoch = getUserViewportInteractionEpoch?.() ?? 0;
        return Number.isFinite(epoch) ? epoch : 0;
    }

    function didUserViewportInteractionAdvance(capturedEpoch: number) {
        return getCurrentUserViewportInteractionEpoch() !== capturedEpoch;
    }

    function canApplyDelayedViewportScroll(
        source: string,
        runId: number,
        capturedEpoch: number,
    ) {
        if (!didUserViewportInteractionAdvance(capturedEpoch)) {
            return true;
        }

        BrowserLogger.diagnostic('pdf-nav', `[${source}] skipped delayed scroll after user viewport interaction`, {
            runId,
            capturedEpoch,
            currentEpoch: getCurrentUserViewportInteractionEpoch(),
            currentPage: currentPage.value,
            visibleRange: {
                start: visibleRange.value.start,
                end: visibleRange.value.end,
            },
            viewer: summarizeViewerMetricsForLog(viewerContainer.value),
        });
        return false;
    }

    function resolveRerenderBufferOverride(source: string) {
        if (
            source === 'zoom-change'
            || source === ZOOM_GESTURE_CHANGE_SOURCE
            || source === 'zoom-settle'
            || source === 'fit-mode'
            || source === 'fit-height-current-page'
            || source === 'fit-width-current-page'
        ) {
            return 0;
        }
        return undefined;
    }

    function resolveMaxCanvasPixelsOverride(source: string) {
        if (source !== ZOOM_GESTURE_CHANGE_SOURCE) {
            return undefined;
        }
        return ZOOM_CHANGE_MAX_CANVAS_PIXELS;
    }

    function getPageElement(pageNumber: number) {
        const container = viewerContainer.value;
        return container?.querySelector<HTMLElement>(
            `.page_container[data-page="${pageNumber}"]`,
        ) ?? null;
    }

    function shouldScheduleZoomSettleForClamp(
        visibleRangeForDecision: IPageRange,
        maxCanvasPixels: number,
    ) {
        if (typeof window === 'undefined') {
            return true;
        }

        const outputScale = window.devicePixelRatio || 1;
        for (
            let pageNumber = visibleRangeForDecision.start;
            pageNumber <= visibleRangeForDecision.end;
            pageNumber += 1
        ) {
            const pageElement = getPageElement(pageNumber);
            if (!pageElement) {
                return true;
            }

            const width = pageElement.offsetWidth || pageElement.clientWidth;
            const height = pageElement.offsetHeight || pageElement.clientHeight;
            if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
                return true;
            }

            const requestedPixels = Math.max(1, Math.round(width * outputScale))
                * Math.max(1, Math.round(height * outputScale));
            if (requestedPixels <= maxCanvasPixels) {
                continue;
            }

            const pixelScaleFactor = Math.sqrt(maxCanvasPixels / requestedPixels);
            if (pixelScaleFactor < ZOOM_CHANGE_SETTLE_CLAMP_SCALE_THRESHOLD) {
                return true;
            }
        }

        return false;
    }

    function canTrustCurrentPageAsZoomAnchor() {
        const page = currentPage.value;
        if (!Number.isFinite(page) || page < 1 || page > numPages.value) {
            return false;
        }
        const range = visibleRange.value;
        return page >= range.start && page <= range.end;
    }

    function resolvePageRowRange(pageNumber: number): IPageRange {
        if (numPages.value <= 0) {
            return {
                start: 1,
                end: 1,
            };
        }
        const rowBounds = getPageRowBoundsForViewMode({
            pageNumber,
            viewMode: viewMode.value,
            totalPages: numPages.value,
        });
        return {
            start: rowBounds.start,
            end: rowBounds.end,
        };
    }

    function isCurrentPageFitRerenderModeActive() {
        return (
            (fitMode.value === 'width' && isFitWidthZoomModeActive())
            || (fitMode.value === 'height' && isFitHeightZoomModeActive())
        );
    }

    function isCurrentPageLatestPagedNavigationIntent(page: number) {
        const targetPage = pagedNavigationTargetPage?.value ?? null;
        return targetPage === null || targetPage === page;
    }

    function isCurrentPageFitRerenderRunActive(
        runId: number,
        document: PDFDocumentProxy | null,
        page: number,
    ) {
        return isViewerAsyncRunActive(runId, currentPageFitRerenderRunId, document)
            && currentPage.value === page
            && isCurrentPageFitRerenderModeActive()
            && isCurrentPageLatestPagedNavigationIntent(page)
            && !continuousScroll.value
            && !isResizing.value;
    }

    function isPagedTargetFitRerenderRunActive(
        runId: number,
        document: PDFDocumentProxy | null,
        page: number,
    ) {
        return isViewerAsyncRunActive(runId, pagedTargetFitRerenderRunId, document)
            && pagedNavigationTargetPage?.value === page
            && isCurrentPageFitRerenderModeActive()
            && !continuousScroll.value
            && !isResizing.value;
    }

    /**
     * Give PDF.js enough time to settle cancelled page renders.
     *
     * PDF.js 5.x intentionally waits 100ms before aborting the operator-list
     * stream for a cancelled render. Restarting the same large page during
     * that window can clear PDF.js's abort timer and leave the replacement
     * render waiting on a half-cancelled stream, which is how rapid fit-height
     * navigation to page 928 produced an infinite skeleton.
     */
    async function waitForCurrentPageFitCancellationToSettle() {
        await nextTick();
        await delay(CURRENT_PAGE_FIT_CANCEL_SETTLE_MS);
    }

    async function runCurrentPageFitRerenderTransition(task: () => Promise<void>) {
        const transitionToken = beginFitRerenderTransition('current-page');
        try {
            await task();
        } finally {
            endFitRerenderTransition(transitionToken);
        }
    }

    function syncFitRerenderTransitionMarkedActive() {
        const active = activeFitRerenderTransitionOwners.size > 0;
        if (isCurrentPageFitRerenderTransitionMarkedActive === active) {
            return;
        }

        isCurrentPageFitRerenderTransitionMarkedActive = active;
        setCurrentPageFitRerenderTransitionActive?.(active);
    }

    function beginFitRerenderTransition(owner: TFitRerenderTransitionOwner) {
        nextFitRerenderTransitionToken += 1;
        activeFitRerenderTransitionOwners.set(nextFitRerenderTransitionToken, owner);
        syncFitRerenderTransitionMarkedActive();
        return nextFitRerenderTransitionToken;
    }

    function endFitRerenderTransition(token: number) {
        if (!activeFitRerenderTransitionOwners.delete(token)) {
            return;
        }
        syncFitRerenderTransitionMarkedActive();
    }

    function endFitRerenderTransitionsForOwner(owner: TFitRerenderTransitionOwner) {
        let changed = false;
        for (const [
            token,
            activeOwner,
        ] of activeFitRerenderTransitionOwners) {
            if (activeOwner !== owner) {
                continue;
            }
            activeFitRerenderTransitionOwners.delete(token);
            changed = true;
        }
        if (changed) {
            syncFitRerenderTransitionMarkedActive();
        }
    }

    /**
     * Prepare the row before fit-current rendering takes over from navigation.
     *
     * The normal paged renderer is suppressed in fit-height/fit-width mode, so
     * this watcher must perform the whole sequence: select the current row,
     * hydrate its page metrics, recompute the fit scale, and refresh skeleton
     * dimensions before starting the only canvas render for that row.
     */
    async function prepareFitPageRerenderLayout(
        runId: number,
        document: PDFDocumentProxy | null,
        page: number,
        isRunActive: () => boolean,
    ) {
        const range = resolvePageRowRange(page);
        await ensurePageMetricsInRange?.(range.start, range.end);
        await nextTick();
        void document;
        void runId;
        if (!isRunActive()) {
            return null;
        }

        computeFitWidthScale(viewerContainer.value, { page });
        setupPagePlaceholders();
        syncHorizontalScrollAfterLayoutUpdate();
        return range;
    }

    /**
     * Keeps fit-height transitions visually atomic by making the intended page
     * position the viewport anchor before renderer work can repaint.
     */
    async function snapFitHeightPageBeforeRender(
        source: string,
        runId: number,
        page: number,
        interactionEpoch: number,
        isRunActive: () => boolean,
    ) {
        for (let attempt = 0; attempt <= FIT_HEIGHT_PRE_RENDER_SNAP_MAX_TICKS; attempt += 1) {
            if (!isRunActive()) {
                return false;
            }
            if (!canApplyDelayedViewportScroll(source, runId, interactionEpoch)) {
                return false;
            }

            const snapResult = scrollToPage(page, {
                preferExactDom: true,
                suppressRenderAfterSnap: true,
            });
            syncHorizontalScrollAfterLayoutUpdate();
            if (snapResult !== false) {
                return true;
            }

            await nextTick();
        }

        BrowserLogger.diagnostic('pdf-nav', `[${source}] could not snap fit-height page before render`, {
            runId,
            page,
            currentPage: currentPage.value,
            visibleRange: {
                start: visibleRange.value.start,
                end: visibleRange.value.end,
            },
            viewer: summarizeViewerMetricsForLog(viewerContainer.value),
        });
        return false;
    }

    function buildRerenderSyncNavLogPayload(runId: number, source: string) {
        return {
            runId,
            source,
            currentPage: currentPage.value,
            visibleRange: {
                start: visibleRange.value.start,
                end: visibleRange.value.end,
            },
            viewer: summarizeViewerMetricsForLog(viewerContainer.value),
        };
    }

    function warnZoomRerenderSync(
        source: string,
        message: string,
        buildPayload: () => Record<string, unknown>,
    ) {
        if (
            source !== 'zoom-change'
            && source !== ZOOM_GESTURE_CHANGE_SOURCE
        ) {
            return;
        }
        BrowserLogger.diagnostic('pdf-zoom-debug', message, buildPayload());
    }

    async function reRenderVisiblePagesAndSyncCurrentPage(
        syncOptions: ICurrentPageSyncOptions = {},
    ) {
        const source = syncOptions.source ?? 're-render';
        const runId = ++reRenderSyncRunId;
        warnZoomRerenderSync(source, `[rerender-sync] begin zoom run=${runId}`, () => ({
            runId,
            source,
            resizeAnchor: syncOptions.resizeAnchor ?? null,
            viewer: summarizeViewerMetricsForLog(viewerContainer.value),
        }));
        BrowserLogger.diagnostic(
            'pdf-nav',
            `[re-render-sync] begin run=${runId} source=${source}`,
            buildRerenderSyncNavLogPayload(runId, source),
        );
        const visibleRangeForDecision = getVisibleRange();
        const preserveExistingPages = shouldPreserveExistingRerenderContent({
            source,
            visibleRange: visibleRangeForDecision,
            isPageRendered,
        });
        const maxCanvasPixelsOverride = resolveMaxCanvasPixelsOverride(source);
        if (
            maxCanvasPixelsOverride !== undefined
            && shouldScheduleZoomSettleForClamp(
                visibleRangeForDecision,
                maxCanvasPixelsOverride,
            )
        ) {
            markLowResZoomRerenderUsed();
        }
        const renderBufferOverride = resolveRerenderBufferOverride(source);
        await reRenderAllVisiblePages(getVisibleRange, {
            preserveExistingPages,
            anchorSnapshot: syncOptions.resizeAnchor?.snapshot ?? null,
            disableHorizontalAnchorRestore: shouldDisableHorizontalAnchorRestore(),
            rerenderSource: source,
            ...(renderBufferOverride !== undefined ? { renderBufferOverride } : {}),
            ...(maxCanvasPixelsOverride !== undefined ? { maxCanvasPixelsOverride } : {}),
        });
        syncHorizontalScrollAfterLayoutUpdate();
        if (runId !== reRenderSyncRunId) {
            warnZoomRerenderSync(source, `[rerender-sync] stale zoom run=${runId}`, () => ({
                runId,
                activeRunId: reRenderSyncRunId,
                viewer: summarizeViewerMetricsForLog(viewerContainer.value),
            }));
            BrowserLogger.diagnostic('pdf-nav', 'Skipped stale re-render current-page sync run', {
                staleRunId: runId,
                activeRunId: reRenderSyncRunId,
                source,
            });
            if (syncOptions.resizeAnchor) {
                scheduleEndResizeTransition(
                    syncOptions.resizeAnchor.transitionToken,
                    'stale-rerender',
                    syncOptions.resizeAnchor.page,
                );
            }
            return;
        }

        warnZoomRerenderSync(source, `[rerender-sync] end zoom run=${runId}`, () => ({
            runId,
            viewer: summarizeViewerMetricsForLog(viewerContainer.value),
            visiblePageSnapshot: summarizeVisiblePageSnapshotForLog(viewerContainer.value),
        }));
        BrowserLogger.diagnostic('pdf-nav', `[re-render-sync] end run=${runId} source=${source}`, {
            ...buildRerenderSyncNavLogPayload(runId, source),
            visiblePageSnapshot: summarizeVisiblePageSnapshotForLog(viewerContainer.value),
        });
        await syncCurrentPageFromViewport(syncOptions);
        syncHorizontalScrollAfterLayoutUpdate();
        if (syncOptions.resizeAnchor) {
            scheduleEndResizeTransition(
                syncOptions.resizeAnchor.transitionToken,
                'resize-rerender-complete',
                syncOptions.resizeAnchor.page,
            );
        }
    }

    watch(fitMode, async (mode) => {
        const runId = ++fitModeRunId;
        const interactionEpoch = getCurrentUserViewportInteractionEpoch();
        const document = pdfDocument.value;
        cancelDestinationNavigationTarget?.();
        resetZoomRerenderQueueState('fit-mode-change');
        const pageToSnapTo =
            mode === 'height'
                ? getMostVisiblePage(viewerContainer.value, numPages.value)
                : null;
        const updated = computeFitWidthScale(viewerContainer.value);
        if (updated && document) {
            const isRunActive = () => (
                isViewerAsyncRunActive(runId, fitModeRunId, document)
                && fitMode.value === mode
            );
            let snappedBeforeRender = false;
            if (pageToSnapTo !== null) {
                setupPagePlaceholders();
                snappedBeforeRender = await snapFitHeightPageBeforeRender(
                    'fit-mode',
                    runId,
                    pageToSnapTo,
                    interactionEpoch,
                    isRunActive,
                );
                if (!isRunActive()) {
                    return;
                }
            }
            cancelInFlightPageRenders?.();
            await reRenderAllVisiblePages(getVisibleRange, {
                preserveExistingPages: true,
                disableHorizontalAnchorRestore: mode === 'width' || shouldDisableHorizontalAnchorRestore(),
                disableVerticalAnchorRestore: mode === 'height',
                disablePageAnchorRestore: mode === 'height',
                rerenderSource: 'fit-mode',
                renderBufferOverride: 0,
            });
            if (!isRunActive()) {
                return;
            }
            syncHorizontalScrollAfterLayoutUpdate();
            if (pageToSnapTo === null) {
                await syncCurrentPageFromViewport({
                    source: 'fit-mode',
                    stabilize: true,
                });
                if (!isRunActive()) {
                    return;
                }
            }
            if (pageToSnapTo !== null && !snappedBeforeRender) {
                await nextTick();
                if (
                    !isRunActive()
                    || !canApplyDelayedViewportScroll('fit-mode', runId, interactionEpoch)
                ) {
                    return;
                }
                scrollToPage(pageToSnapTo, {
                    preferExactDom: true,
                    suppressRenderAfterSnap: true,
                });
                syncHorizontalScrollAfterLayoutUpdate();
            }
        }
    });

    watch(viewMode, async () => {
        const runId = ++viewModeRunId;
        const document = pdfDocument.value;
        cancelDestinationNavigationTarget?.();
        if (!document || isLoading.value) {
            return;
        }

        const targetViewMode = viewMode.value;
        resetContinuousScrollState();
        const updated = computeFitWidthScale(viewerContainer.value);
        if (updated) {
            setupPagePlaceholders();
        }

        cancelInFlightPageRenders?.();
        await reRenderAllVisiblePages(getVisibleRange, { disableHorizontalAnchorRestore: shouldDisableHorizontalAnchorRestore() });
        if (!isViewerAsyncRunActive(runId, viewModeRunId, document) || viewMode.value !== targetViewMode) {
            return;
        }
        syncHorizontalScrollAfterLayoutUpdate();
        syncHorizontalScrollAfterLayoutUpdate();
    });

    watch(currentPage, async (next, previous) => {
        const runId = ++currentPageFitRerenderRunId;
        const interactionEpoch = getCurrentUserViewportInteractionEpoch();
        const document = pdfDocument.value;
        if (
            next === previous
            || !isCurrentPageFitRerenderModeActive()
            || continuousScroll.value
            || !document
            || isLoading.value
            || isResizing.value
        ) {
            endFitRerenderTransitionsForOwner('current-page');
            return;
        }

        await runCurrentPageFitRerenderTransition(async () => {
            /**
             * Coalesce rapid paged toolbar navigation before rerendering fit modes.
             *
             * Fit-height and fit-width recompute scale on every current-page change.
             * If page 2, 3, ..., 30 each starts its own rerender, those stale jobs can
             * keep bumping the renderer version after a later last-page jump and
             * repeatedly cancel the final page. Waiting a short settle window and
             * checking the run id lets ordinary single-page navigation stay prompt
             * while making the last requested page the only rerender authority.
             */
            await delay(CURRENT_PAGE_FIT_RERENDER_SETTLE_MS);
            await nextTick();
            if (!isCurrentPageFitRerenderRunActive(runId, document, next)) {
                return;
            }

            const range = await prepareFitPageRerenderLayout(runId, document, next, () => (
                isCurrentPageFitRerenderRunActive(runId, document, next)
            ));
            if (!range || !isCurrentPageFitRerenderRunActive(runId, document, next)) {
                return;
            }

            if (fitMode.value === 'height') {
                const snappedBeforeRender = await snapFitHeightPageBeforeRender(
                    'fit-height-current-page',
                    runId,
                    next,
                    interactionEpoch,
                    () => (
                        isCurrentPageFitRerenderRunActive(runId, document, next)
                        && fitMode.value === 'height'
                    ),
                );
                if (
                    !isCurrentPageFitRerenderRunActive(runId, document, next)
                    || fitMode.value !== 'height'
                ) {
                    return;
                }
                cancelInFlightPageRenders?.();
                await waitForCurrentPageFitCancellationToSettle();
                if (
                    !isCurrentPageFitRerenderRunActive(runId, document, next)
                    || fitMode.value !== 'height'
                ) {
                    return;
                }
                await reRenderAllVisiblePages(() => range, {
                    preserveExistingPages: true,
                    disableHorizontalAnchorRestore: shouldDisableHorizontalAnchorRestore(),
                    disableVerticalAnchorRestore: true,
                    disablePageAnchorRestore: true,
                    rerenderSource: 'fit-height-current-page',
                    renderBufferOverride: 0,
                });
                if (
                    !isCurrentPageFitRerenderRunActive(runId, document, next)
                    || fitMode.value !== 'height'
                ) {
                    return;
                }
                await nextTick();
                if (snappedBeforeRender) {
                    syncHorizontalScrollAfterLayoutUpdate();
                    return;
                }
                if (
                    !isCurrentPageFitRerenderRunActive(runId, document, next)
                    || fitMode.value !== 'height'
                    || !canApplyDelayedViewportScroll(
                        'fit-height-current-page',
                        runId,
                        interactionEpoch,
                    )
                ) {
                    return;
                }
                scrollToPage(next, {
                    preferExactDom: true,
                    suppressRenderAfterSnap: true,
                });
                syncHorizontalScrollAfterLayoutUpdate();
                return;
            }

            const resizeAnchor = buildResizeAnchorContext({
                preferredAnchorPage: next,
                trustPreferredAnchorPage: true,
            });
            if (
                !isCurrentPageFitRerenderRunActive(runId, document, next)
                || fitMode.value !== 'width'
            ) {
                return;
            }
            cancelInFlightPageRenders?.();
            await waitForCurrentPageFitCancellationToSettle();
            if (
                !isCurrentPageFitRerenderRunActive(runId, document, next)
                || fitMode.value !== 'width'
            ) {
                return;
            }
            await reRenderVisiblePagesAndSyncCurrentPage({
                source: 'fit-width-current-page',
                stabilize: true,
                resizeAnchor,
            });
        });
    });

    watch(
        () => pagedNavigationTargetPage?.value ?? null,
        async (next, previous) => {
            const runId = ++pagedTargetFitRerenderRunId;
            const interactionEpoch = getCurrentUserViewportInteractionEpoch();
            const document = pdfDocument.value;
            if (
                next === null
                || next === previous
                || !isCurrentPageFitRerenderModeActive()
                || continuousScroll.value
                || !document
                || isLoading.value
                || isResizing.value
            ) {
                endFitRerenderTransitionsForOwner('paged-target');
                return;
            }

            const transitionToken = beginFitRerenderTransition('paged-target');
            try {
                await delay(CURRENT_PAGE_FIT_RERENDER_SETTLE_MS);
                await nextTick();
                const isRunActive = () => isPagedTargetFitRerenderRunActive(runId, document, next);
                if (!isRunActive()) {
                    return;
                }

                const range = await prepareFitPageRerenderLayout(runId, document, next, isRunActive);
                if (!range || !isRunActive()) {
                    return;
                }

                // The paged navigation hold is released only by the final
                // canvas readiness callback; low-res previews are no longer a
                // valid visual authority for committing the target page.
                if (fitMode.value === 'height') {
                    await snapFitHeightPageBeforeRender(
                        'fit-height-paged-target',
                        runId,
                        next,
                        interactionEpoch,
                        () => isRunActive() && fitMode.value === 'height',
                    );
                    if (!isRunActive() || fitMode.value !== 'height') {
                        return;
                    }
                }

                cancelInFlightPageRenders?.();
                await waitForCurrentPageFitCancellationToSettle();
                if (!isRunActive()) {
                    return;
                }
                await reRenderAllVisiblePages(() => range, {
                    preserveExistingPages: true,
                    disableHorizontalAnchorRestore: true,
                    disableVerticalAnchorRestore: fitMode.value === 'height',
                    disablePageAnchorRestore: fitMode.value === 'height',
                    rerenderSource: fitMode.value === 'height'
                        ? 'fit-height-paged-target'
                        : 'fit-width-paged-target',
                    renderBufferOverride: 0,
                });
                if (isRunActive()) {
                    syncHorizontalScrollAfterLayoutUpdate();
                }
            } finally {
                endFitRerenderTransition(transitionToken);
            }
        },
    );

    watch(
        () => continuousScroll.value,
        async (next, previous) => {
            const runId = ++continuousScrollRunId;
            const document = pdfDocument.value;
            // Capture the page the user is currently looking at BEFORE any
            // state reset, so the post-toggle snap target reflects the
            // pre-toggle viewport — matching pdf.js's scrollMode setter
            // (which calls _setCurrentPageNumber(currentPageNumber, reset=true)
            // anchored at the page top-left), and Adobe / Preview behavior.
            const pageToSnapTo = getMostVisiblePage(
                viewerContainer.value,
                numPages.value,
            );
            resetContinuousScrollState();
            if (fitMode.value === 'height' && pdfDocument.value) {
                computeFitWidthScale(viewerContainer.value);
            }
            if (
                previous !== next
                && document
                && !isLoading.value
            ) {
                await nextTick();
                if (
                    !isViewerAsyncRunActive(runId, continuousScrollRunId, document)
                    || continuousScroll.value !== next
                ) {
                    return;
                }
                scrollToPage(pageToSnapTo, { preferExactDom: true });
                syncHorizontalScrollAfterLayoutUpdate();
            }
        },
    );

    watch(zoom, (nextZoom, previousZoom) => {
        if (pdfDocument.value) {
            if (consumeSuppressedZoomRerender?.(nextZoom)) {
                return;
            }
            cancelDestinationNavigationTarget?.();
            cancelInFlightPageRenders?.();
            const zoomViewportAnchor = consumeZoomViewportAnchor?.() ?? null;
            const trustCurrentPageAnchor = !zoomViewportAnchor && canTrustCurrentPageAsZoomAnchor();
            const zoomRerenderSource = zoomViewportAnchor
                ? ZOOM_GESTURE_CHANGE_SOURCE
                : 'zoom-change';
            const zoomAnchor = buildResizeAnchorContext({
                anchorViewportX: zoomViewportAnchor?.x ?? null,
                anchorViewportY: zoomViewportAnchor?.y ?? null,
                preferredAnchorPage: currentPage.value,
                trustPreferredAnchorPage: trustCurrentPageAnchor,
            });
            BrowserLogger.diagnosticThrottled('pdf-zoom-debug', 'zoom-watch-schedule-rerender', ZOOM_QUEUE_LOG_THROTTLE_MS, '[zoom-watch] schedule zoom rerender', {
                previousZoom,
                nextZoom,
                consumedZoomViewportAnchor: zoomViewportAnchor,
                trustCurrentPageAnchor,
                zoomRerenderSource,
                builtZoomAnchor: zoomAnchor,
                viewer: summarizeViewerMetricsForLog(viewerContainer.value),
            });
            enqueueZoomSync({
                source: zoomRerenderSource,
                stabilize: true,
                resizeAnchor: zoomAnchor,
            });
        }
    });

    watch(isResizing, async (value) => {
        const runId = ++resizeSettleRunId;
        const document = pdfDocument.value;
        if (value || !document || isLoading.value) {
            return;
        }

        await nextTick();
        await delay(20);
        if (!isViewerAsyncRunActive(runId, resizeSettleRunId, document) || isResizing.value) {
            return;
        }
        const pendingAnchorPage = pagedNavigationTargetPage?.value ?? null;
        const preferredAnchorPage = pendingAnchorPage ?? currentPage.value;
        const resizeAnchor = buildResizeAnchorContext({
            ...(pendingAnchorPage !== null
                ? { forcePreferredAnchorPage: true }
                : {}),
            preferredAnchorPage,
            trustPreferredAnchorPage: true,
        });
        const updated = computeFitWidthScale(viewerContainer.value);
        if (!updated) {
            return;
        }

        const transitionToken = beginResizeTransition(
            'resize-settle',
            resizeAnchor.page,
        );
        scheduleResizeAwareRerender(
            're-render visible pages after resize settle',
            {
                source: 'resize-settle',
                stabilize: true,
                resizeAnchor: {
                    ...resizeAnchor,
                    transitionToken,
                },
            },
        );
    });

    return {reRenderVisiblePagesAndSyncCurrentPage};
};
