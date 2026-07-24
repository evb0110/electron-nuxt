import { delay } from 'es-toolkit/promise';
import { BrowserLogger } from '@app/utils/browserLogger';
import type {
    PDFDocumentProxy,
    TFitMode,
} from '@app/types/pdfContracts';
import type { IPageRange } from '@app/types/pdfUi';
import type { ICurrentPageSyncOptions } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerCurrentPageSync';
import { getPageRowBoundsForViewMode } from '@app/modules/pdf-viewer/engine/pdf-page-layout/getPageRowBoundsForViewMode';
import type { TPdfViewerTransactionState } from '@app/modules/pdf-viewer/engine/pdf-viewer-transaction/pdfViewerTransactionTypes';
import type { IUsePdfViewerRerenderCoordinatorOptions } from '@app/modules/pdf-viewer/runtime/composables/pdfRerenderCoordinatorTypes';
import {
    PDF_RERENDER_SOURCE,
    isZoomRestorePdfRerenderSource,
    normalizePdfRerenderSource,
    shouldUseMinimalPdfRerenderBuffer,
} from '@app/modules/pdf-viewer/runtime/rerender-protocol/pdfRerenderProtocol';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';

const ZOOM_QUEUE_LOG_THROTTLE_MS = 420;

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
        zoom,
        zoomMode,
        fitMode,
        viewMode,
        isResizing,
        continuousScroll,
        getVisibleRange,
        reRenderAllVisiblePages,
        summarizeViewerMetricsForLog,
        summarizeVisiblePageSnapshotForLog,
        syncCurrentPageFromViewport,
        buildResizeAnchorContext,
        captureResizeVisualSnapshots,
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
        const renderBufferOverride = resolveRerenderBufferOverride(source);
        if (!advanceSyncTransaction(syncOptions, 'render-requested')) {
            return;
        }
        if (syncOptions.resizeAnchor && isZoomRestorePdfRerenderSource(source)) {
            // Custom zoom replaces the committed backing canvas after the page
            // geometry has already changed. Keep a raster snapshot outside the
            // render layer until the target-scale canvas commits so the viewer
            // never exposes an old canvas or a bare page shell between frames.
            captureResizeVisualSnapshots?.(syncOptions.resizeAnchor);
        }
        await reRenderAllVisiblePages(getVisibleRange, {
            rerenderSource: source,
            ...(renderBufferOverride !== undefined ? { renderBufferOverride } : {}),
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
        // Navigation/viewport authority owns the semantic anchor across fit
        // geometry changes. Cancelling it here reinterprets the pre-fit pixel
        // scroll position under changing page metrics and can advance the
        // current page without any user navigation.
        resetZoomRerenderQueueState(`${source}-change`);
        const pageToPreserve = navigationAnchorPage?.value ?? currentPage.value;
        const pageToSnapTo =
            mode === 'height'
                ? pageToPreserve
                : null;
        const updated = pageToSnapTo === null
            ? computeFitWidthScale(viewerContainer.value)
            : computeFitWidthScale(viewerContainer.value, { page: pageToSnapTo });
        if ((updated || options.forceRerender === true) && document) {
            if (pageToSnapTo !== null) {
                setupPagePlaceholders();
                if (!isRunActive()) {
                    return;
                }
            }
            void cancelInFlightPageRenders?.();
            await reRenderAllVisiblePages(getVisibleRange, {
                rerenderSource: normalizePdfRerenderSource(source),
                renderBufferOverride: 0,
            });
            if (!isRunActive()) {
                return;
            }
            if (pageToSnapTo === null) {
                // Fit-width changes every row's physical top. The old
                // scrollTop is not meaningful under the new geometry and can
                // make the viewport observer overwrite a committed page-2
                // navigation with page 1. Re-project the semantic page owner
                // before any post-render viewport sampling runs.
                await nextTick();
                if (
                    !isRunActive()
                    || !canApplyDelayedViewportScroll(source, runId, interactionEpoch)
                ) {
                    return;
                }
                await Promise.resolve(scrollToPage(pageToPreserve, {
                    preferExactDom: true,
                    suppressRenderAfterSnap: true,
                }));
                syncHorizontalScrollAfterLayoutUpdate();
                return;
            }
            syncHorizontalScrollAfterLayoutUpdate();
            if (pageToSnapTo !== null) {
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
                    ...(zoomViewportAnchor?.sessionId !== undefined
                        ? {zoomGestureSessionId: zoomViewportAnchor.sessionId}
                        : {}),
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
        const document = pdfDocument.value;
        if (
            next === previous
            || !isCurrentPageFitRerenderModeActive()
            || continuousScroll.value
            || !document
            || isLoading.value
            || isResizing.value
            || pagedNavigationTargetPage?.value === next
        ) {
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
            const range = await prepareFitPageRerenderLayout(runId, document, next, () => (
                isCurrentPageFitRerenderRunActive(runId, document, next)
            ));
            if (!range || !isCurrentPageFitRerenderRunActive(runId, document, next)) {
                return;
            }
            if (fitMode.value === 'height') {
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
            logPdfRenderTrace('zoom-rerender-anchor-captured', () => ({
                previousZoom,
                nextZoom,
                currentPage: currentPage.value,
                visibleRange: {...visibleRange.value},
                trustCurrentPageAnchor,
                anchorPage: zoomAnchor.page,
                semanticAnchorPage: zoomAnchor.semanticAnchor?.page ?? null,
                navigationAnchorPage: navigationAnchorPage?.value ?? null,
                pagedNavigationTargetPage: pagedNavigationTargetPage?.value ?? null,
            }));
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
                ...(zoomViewportAnchor?.sessionId !== undefined
                    ? {zoomGestureSessionId: zoomViewportAnchor.sessionId}
                    : {}),
                zoomLockOperationId: zoomViewportAnchor?.zoomLockOperationId ?? null,
            });
        }
    });

    return {reRenderVisiblePagesAndSyncCurrentPage};
};
