import { delay } from 'es-toolkit/promise';
import { BrowserLogger } from '@app/utils/browserLogger';
import type {
    PDFDocumentProxy,
    TFitMode,
} from '@app/types/pdfContracts';
import type { IPageRange } from '@app/types/pdfUi';
import type { ICurrentPageSyncOptions } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerCurrentPageSync';
import { shouldPreserveExistingRerenderContent } from '@app/modules/pdf-viewer/runtime/rerender-strategy/shouldPreserveExistingRerenderContent';
import { getPageRowBoundsForViewMode } from '@app/modules/pdf-viewer/engine/pdf-page-layout/getPageRowBoundsForViewMode';
import type { TPdfViewerTransactionState } from '@app/modules/pdf-viewer/engine/pdf-viewer-transaction/pdfViewerTransactionTypes';
import type { IUsePdfViewerRerenderCoordinatorOptions } from '@app/modules/pdf-viewer/runtime/composables/pdfRerenderCoordinatorTypes';
import {
    PDF_RERENDER_SOURCE,
    isZoomRestorePdfRerenderSource,
    normalizePdfRerenderSource,
    shouldUseMinimalPdfRerenderBuffer,
    shouldUseZoomGestureCanvasCap,
} from '@app/modules/pdf-viewer/runtime/rerender-protocol/pdfRerenderProtocol';

const ZOOM_QUEUE_LOG_THROTTLE_MS = 420;
const ZOOM_CHANGE_MAX_CANVAS_PIXELS = 14_000_000;
const ZOOM_CHANGE_SETTLE_CLAMP_SCALE_THRESHOLD = 0.98;

export const usePdfViewerRerenderCoordinator = (options: IUsePdfViewerRerenderCoordinatorOptions) => {
    const {
        viewerContainer,
        pdfDocument,
        isLoading,
        numPages,
        currentPage,
        pagedNavigationTargetPage,
        navigationAnchorPage,
        visibleRange,
        commitVisibleRange,
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
        consumeSuppressedZoomRerender,
        transactionController,
    } = options;

    let reRenderSyncRunId = 0;
    let fitModeRunId = 0;
    let currentPageFitRerenderRunId = 0;
    let pagedTargetFitRerenderRunId = 0;
    let viewModeRunId = 0;
    let continuousScrollRunId = 0;

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
        return shouldUseMinimalPdfRerenderBuffer(source)
            ? 0
            : undefined;
    }

    function resolveMaxCanvasPixelsOverride(source: string) {
        if (!shouldUseZoomGestureCanvasCap(source)) {
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

    function consumePagedTargetFitRenderHandoff(
        page: number,
        document: PDFDocumentProxy,
    ) {
        if (!isCurrentPageFitRerenderModeActive()) {
            return false;
        }
        const range = transactionController?.consumePagedTargetFitRenderHandoff?.({
            document,
            fitMode: fitMode.value,
            page,
            viewMode: viewMode.value,
            continuousScroll: continuousScroll.value,
            isResizing: isResizing.value,
        }) ?? null;
        if (!range) {
            return false;
        }

        if (commitVisibleRange?.(range) === false) {
            return false;
        }
        if (!commitVisibleRange) {
            visibleRange.value = range;
        }
        syncHorizontalScrollAfterLayoutUpdate();
        return true;
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

    async function cancelCurrentPageFitRendersAndWaitForSettle() {
        await cancelInFlightPageRenders?.();
        await nextTick();
    }

    async function runCurrentPageFitRerenderTransition(task: () => Promise<void>) {
        await task();
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
    function snapFitHeightPageBeforeRender(
        source: string,
        runId: number,
        page: number,
        interactionEpoch: number,
        isRunActive: () => boolean,
    ) {
        if (!isRunActive() || !canApplyDelayedViewportScroll(source, runId, interactionEpoch)) {
            return false;
        }
        const snapResult = scrollToPage(page, {
            preferExactDom: true,
            suppressRenderAfterSnap: true,
        });
        syncHorizontalScrollAfterLayoutUpdate();
        return snapResult !== false;
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
        if (!isZoomRestorePdfRerenderSource(source)) {
            return;
        }
        BrowserLogger.diagnostic('pdf-zoom-debug', message, buildPayload());
    }

    function isSyncTransactionCurrent(syncOptions: ICurrentPageSyncOptions) {
        return syncOptions.transactionId === undefined
            || transactionController?.isTransactionCurrent(syncOptions.transactionId) !== false;
    }

    function advanceSyncTransaction(
        syncOptions: ICurrentPageSyncOptions,
        state: Exclude<TPdfViewerTransactionState, 'preparing' | 'cancelled'>,
    ) {
        if (syncOptions.transactionId === undefined) {
            return true;
        }
        return transactionController?.advanceTransaction(syncOptions.transactionId, state) !== false;
    }

    async function reRenderVisiblePagesAndSyncCurrentPage(
        syncOptions: ICurrentPageSyncOptions = {},
    ) {
        const source = normalizePdfRerenderSource(
            syncOptions.source,
            PDF_RERENDER_SOURCE.ReRender,
        );
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
        if (!isSyncTransactionCurrent(syncOptions)) {
            if (syncOptions.resizeAnchor) {
                scheduleEndResizeTransition(
                    syncOptions.resizeAnchor.transitionToken,
                    'stale-rerender-transaction',
                    syncOptions.resizeAnchor.page,
                );
            }
            return;
        }
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
        if (!advanceSyncTransaction(syncOptions, 'render-requested')) {
            return;
        }
        await reRenderAllVisiblePages(getVisibleRange, {
            preserveExistingPages,
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
        if (!isSyncTransactionCurrent(syncOptions)) {
            if (syncOptions.resizeAnchor) {
                scheduleEndResizeTransition(
                    syncOptions.resizeAnchor.transitionToken,
                    'stale-rerender-transaction',
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
        if (!isSyncTransactionCurrent(syncOptions)) {
            return;
        }
        syncHorizontalScrollAfterLayoutUpdate();
        if (syncOptions.resizeAnchor) {
            scheduleEndResizeTransition(
                syncOptions.resizeAnchor.transitionToken,
                'resize-rerender-complete',
                syncOptions.resizeAnchor.page,
            );
        }
        advanceSyncTransaction(syncOptions, 'settled');
    }

    async function handleFitScaleModeChange(
        source: string,
        mode: TFitMode,
        runId: number,
        document: PDFDocumentProxy | null,
        interactionEpoch: number,
        isRunActive: () => boolean,
        options: {forceRerender?: boolean} = {},
    ) {
        cancelDestinationNavigationTarget?.();
        resetZoomRerenderQueueState(`${source}-change`);
        const pageToSnapTo =
            mode === 'height'
                ? getMostVisiblePage(viewerContainer.value, numPages.value)
                : null;
        const updated = pageToSnapTo === null
            ? computeFitWidthScale(viewerContainer.value)
            : computeFitWidthScale(viewerContainer.value, { page: pageToSnapTo });
        if ((updated || options.forceRerender === true) && document) {
            let snappedBeforeRender = false;
            if (pageToSnapTo !== null) {
                setupPagePlaceholders();
                snappedBeforeRender = snapFitHeightPageBeforeRender(
                    source,
                    runId,
                    pageToSnapTo,
                    interactionEpoch,
                    isRunActive,
                );
                if (!isRunActive()) {
                    return;
                }
            }
            void cancelInFlightPageRenders?.();
            await reRenderAllVisiblePages(getVisibleRange, {
                preserveExistingPages: true,
                rerenderSource: normalizePdfRerenderSource(source),
                renderBufferOverride: 0,
            });
            if (!isRunActive()) {
                return;
            }
            syncHorizontalScrollAfterLayoutUpdate();
            if (pageToSnapTo === null) {
                await syncCurrentPageFromViewport({
                    source,
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
                    || !canApplyDelayedViewportScroll(source, runId, interactionEpoch)
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
    }

    watch(fitMode, async (mode) => {
        if (zoomMode && zoomMode.value !== (mode === 'height' ? 'fit-height' : 'fit-width')) {
            return;
        }
        const runId = ++fitModeRunId;
        const interactionEpoch = getCurrentUserViewportInteractionEpoch();
        const document = pdfDocument.value;
        await handleFitScaleModeChange(
            PDF_RERENDER_SOURCE.FitMode,
            mode,
            runId,
            document,
            interactionEpoch,
            () => (
                isViewerAsyncRunActive(runId, fitModeRunId, document)
                && fitMode.value === mode
            ),
        );
    });

    if (zoomMode) {
        watch(zoomMode, async (mode, previousMode) => {
            if (mode === previousMode) {
                return;
            }
            if (mode === 'custom') {
                if (!pdfDocument.value) {
                    return;
                }
                cancelDestinationNavigationTarget?.();
                void cancelInFlightPageRenders?.();
                const zoomViewportAnchor = consumeZoomViewportAnchor?.() ?? null;
                const trustCurrentPageAnchor = !zoomViewportAnchor && canTrustCurrentPageAsZoomAnchor();
                const zoomAnchor = buildResizeAnchorContext({
                    preferredAnchorPage: currentPage.value,
                    trustPreferredAnchorPage: trustCurrentPageAnchor,
                });
                enqueueZoomSync({
                    source: PDF_RERENDER_SOURCE.ZoomModeChange,
                    stabilize: true,
                    resizeAnchor: zoomAnchor,
                    zoomLockOperationId: zoomViewportAnchor?.zoomLockOperationId ?? null,
                });
                return;
            }

            const modeFitMode: TFitMode = mode === 'fit-height' ? 'height' : 'width';
            if (fitMode.value !== modeFitMode) {
                return;
            }

            const runId = ++fitModeRunId;
            const interactionEpoch = getCurrentUserViewportInteractionEpoch();
            const document = pdfDocument.value;
            await handleFitScaleModeChange(
                PDF_RERENDER_SOURCE.ZoomMode,
                modeFitMode,
                runId,
                document,
                interactionEpoch,
                () => (
                    isViewerAsyncRunActive(runId, fitModeRunId, document)
                    && zoomMode.value === mode
                    && fitMode.value === modeFitMode
                ),
                { forceRerender: true },
            );
        });
    }

    watch(viewMode, async () => {
        const runId = ++viewModeRunId;
        const document = pdfDocument.value;
        const activeNavigationAnchorPage = navigationAnchorPage?.value ?? null;
        if (activeNavigationAnchorPage === null) {
            cancelDestinationNavigationTarget?.();
        }
        if (!document || isLoading.value) {
            return;
        }

        const targetViewMode = viewMode.value;
        resetContinuousScrollState();
        const updated = computeFitWidthScale(viewerContainer.value);
        if (updated) {
            setupPagePlaceholders();
        }

        void cancelInFlightPageRenders?.();
        await reRenderAllVisiblePages(getVisibleRange, {rerenderSource: PDF_RERENDER_SOURCE.ViewMode});
        if (!isViewerAsyncRunActive(runId, viewModeRunId, document) || viewMode.value !== targetViewMode) {
            return;
        }
        syncHorizontalScrollAfterLayoutUpdate();
        if (activeNavigationAnchorPage !== null) {
            scrollToPage(activeNavigationAnchorPage, { preferExactDom: true });
        }
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
            return;
        }
        if (consumePagedTargetFitRenderHandoff(next, document)) {
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
            await delay(50);
            if (!isCurrentPageFitRerenderRunActive(runId, document, next)) {
                return;
            }
            if (consumePagedTargetFitRenderHandoff(next, document)) {
                return;
            }
            const range = await prepareFitPageRerenderLayout(runId, document, next, () => (
                isCurrentPageFitRerenderRunActive(runId, document, next)
            ));
            if (!range || !isCurrentPageFitRerenderRunActive(runId, document, next)) {
                return;
            }
            if (consumePagedTargetFitRenderHandoff(next, document)) {
                return;
            }

            if (fitMode.value === 'height') {
                const snappedBeforeRender = snapFitHeightPageBeforeRender(
                    PDF_RERENDER_SOURCE.FitHeightCurrentPage,
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
                await cancelCurrentPageFitRendersAndWaitForSettle();
                if (
                    !isCurrentPageFitRerenderRunActive(runId, document, next)
                    || fitMode.value !== 'height'
                ) {
                    return;
                }
                await reRenderAllVisiblePages(() => range, {
                    preserveExistingPages: true,
                    rerenderSource: PDF_RERENDER_SOURCE.FitHeightCurrentPage,
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
                        PDF_RERENDER_SOURCE.FitHeightCurrentPage,
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
            await cancelCurrentPageFitRendersAndWaitForSettle();
            if (
                !isCurrentPageFitRerenderRunActive(runId, document, next)
                || fitMode.value !== 'width'
            ) {
                return;
            }
            await reRenderVisiblePagesAndSyncCurrentPage({
                source: PDF_RERENDER_SOURCE.FitWidthCurrentPage,
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
                return;
            }
            {
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
                    snapFitHeightPageBeforeRender(
                        PDF_RERENDER_SOURCE.FitHeightPagedTarget,
                        runId,
                        next,
                        interactionEpoch,
                        () => isRunActive() && fitMode.value === 'height',
                    );
                    if (!isRunActive() || fitMode.value !== 'height') {
                        return;
                    }
                }

                await cancelCurrentPageFitRendersAndWaitForSettle();
                if (!isRunActive()) {
                    return;
                }
                const transaction = transactionController?.beginTransaction({
                    kind: 'rerender',
                    source: 'fit-paged-target',
                    page: next,
                    range,
                    fitPlan: {
                        mode: fitMode.value === 'height' ? 'fit-height' : 'fit-width',
                        scalePage: next,
                        hydrateRange: range,
                        viewMode: viewMode.value,
                        pagedTargetRenderHandoff: 'pending',
                    },
                }) ?? null;
                if (transaction) {
                    transactionController?.advanceTransaction(transaction.id, 'render-requested');
                }
                await reRenderAllVisiblePages(() => range, {
                    preserveExistingPages: true,
                    rerenderSource: fitMode.value === 'height'
                        ? PDF_RERENDER_SOURCE.FitHeightPagedTarget
                        : PDF_RERENDER_SOURCE.FitWidthPagedTarget,
                    renderBufferOverride: 0,
                });
                if (transaction) {
                    transactionController?.advanceTransaction(transaction.id, 'settled');
                }
                if (isRunActive()) {
                    syncHorizontalScrollAfterLayoutUpdate();
                }
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
            void cancelInFlightPageRenders?.();
            const zoomViewportAnchor = consumeZoomViewportAnchor?.() ?? null;
            const trustCurrentPageAnchor = !zoomViewportAnchor && canTrustCurrentPageAsZoomAnchor();
            const zoomRerenderSource = zoomViewportAnchor
                ? PDF_RERENDER_SOURCE.ZoomGestureChange
                : PDF_RERENDER_SOURCE.ZoomChange;
            const zoomAnchor = buildResizeAnchorContext({
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
                zoomLockOperationId: zoomViewportAnchor?.zoomLockOperationId ?? null,
            });
        }
    });

    return {reRenderVisiblePagesAndSyncCurrentPage};
};
