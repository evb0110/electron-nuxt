import type {
    ComputedRef,
    Ref,
} from 'vue';
import { delay } from 'es-toolkit/promise';
import { BrowserLogger } from '@app/utils/browser-logger';
import type {
    PDFDocumentProxy,
    IScrollSnapshot,
    TFitMode,
    TPdfViewMode,
    TZoomMode,
} from '@app/types/pdf';
import type {
    ICurrentPageSyncOptions,
    IResizeAnchorContext,
} from '@app/modules/pdf-viewer-runtime/composables/usePdfViewerCurrentPageSync';
import type { IBuildResizeAnchorContextOptions } from '@app/modules/pdf-viewer-runtime/composables/usePdfViewerResizeLifecycle';
import { shouldPreserveExistingRerenderContent } from '@app/modules/pdf-viewer-runtime/rerenderStrategy';

const ZOOM_QUEUE_LOG_THROTTLE_MS = 420;
const ZOOM_CHANGE_MAX_CANVAS_PIXELS = 14_000_000;

interface IPageRange {
    start: number;
    end: number;
}

interface IZoomViewportAnchor {
    id?: number;
    sessionId?: number;
    x: number;
    y: number;
    capturedAtMs: number;
}

interface IUsePdfViewerRerenderCoordinatorOptions {
    viewerContainer: Ref<HTMLElement | null>;
    pdfDocument: Ref<PDFDocumentProxy | null>;
    isLoading: Ref<boolean>;
    numPages: Ref<number>;
    currentPage: Ref<number>;
    visibleRange: Ref<IPageRange>;
    zoom: ComputedRef<number>;
    zoomMode?: ComputedRef<TZoomMode>;
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
            renderBufferOverride?: number;
            maxCanvasPixelsOverride?: number;
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
    cancelInFlightPageRenders?: () => void;
    computeFitWidthScale: (container: HTMLElement | null) => boolean;
    syncHorizontalScrollForZoomMode?: () => boolean;
    setupPagePlaceholders: () => void;
    scrollToPage: (pageNumber: number, options?: { preferExactDom?: boolean }) => void;
    getMostVisiblePage: (container: HTMLElement | null, numPages: number) => number;
    resetContinuousScrollState: () => void;
    resetZoomRerenderQueueState: (reason: string) => void;
    consumeZoomViewportAnchor?: () => IZoomViewportAnchor | null;
    beginResizeTransition: (source: string, anchorPage: number | null) => number;
    consumeSuppressedZoomRerender?: (nextZoom: number) => boolean;
}

export const usePdfViewerRerenderCoordinator = (options: IUsePdfViewerRerenderCoordinatorOptions) => {
    const {
        viewerContainer,
        pdfDocument,
        isLoading,
        numPages,
        currentPage,
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
        computeFitWidthScale,
        syncHorizontalScrollForZoomMode,
        setupPagePlaceholders,
        scrollToPage,
        getMostVisiblePage,
        resetContinuousScrollState,
        resetZoomRerenderQueueState,
        consumeZoomViewportAnchor,
        beginResizeTransition,
        consumeSuppressedZoomRerender,
    } = options;

    let reRenderSyncRunId = 0;

    function isFitWidthZoomModeActive() {
        return zoomMode
            ? zoomMode.value === 'fit-width'
            : fitMode.value === 'width';
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

    function resolveRerenderBufferOverride(source: string) {
        if (source === 'zoom-change' || source === 'zoom-settle' || source === 'fit-mode') {
            return 0;
        }
        return undefined;
    }

    function resolveMaxCanvasPixelsOverride(source: string) {
        if (source !== 'zoom-change') {
            return undefined;
        }
        return ZOOM_CHANGE_MAX_CANVAS_PIXELS;
    }

    function canTrustCurrentPageAsZoomAnchor() {
        const page = currentPage.value;
        if (!Number.isFinite(page) || page < 1 || page > numPages.value) {
            return false;
        }
        const range = visibleRange.value;
        return page >= range.start && page <= range.end;
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
        if (source !== 'zoom-change') {
            return;
        }
        BrowserLogger.warn('pdf-zoom-debug', message, buildPayload());
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
        BrowserLogger.warn(
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
        if (maxCanvasPixelsOverride !== undefined) {
            markLowResZoomRerenderUsed();
        }
        await reRenderAllVisiblePages(getVisibleRange, {
            preserveExistingPages,
            anchorSnapshot: syncOptions.resizeAnchor?.snapshot ?? null,
            disableHorizontalAnchorRestore: shouldDisableHorizontalAnchorRestore(),
            rerenderSource: source,
            renderBufferOverride: resolveRerenderBufferOverride(source),
            maxCanvasPixelsOverride,
        });
        syncHorizontalScrollAfterLayoutUpdate();
        if (runId !== reRenderSyncRunId) {
            warnZoomRerenderSync(source, `[rerender-sync] stale zoom run=${runId}`, () => ({
                runId,
                activeRunId: reRenderSyncRunId,
                viewer: summarizeViewerMetricsForLog(viewerContainer.value),
            }));
            BrowserLogger.warn('pdf-nav', 'Skipped stale re-render current-page sync run', {
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
        BrowserLogger.warn('pdf-nav', `[re-render-sync] end run=${runId} source=${source}`, {
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
        resetZoomRerenderQueueState('fit-mode-change');
        const pageToSnapTo =
            mode === 'height'
                ? getMostVisiblePage(viewerContainer.value, numPages.value)
                : null;
        const updated = computeFitWidthScale(viewerContainer.value);
        if (updated && pdfDocument.value) {
            cancelInFlightPageRenders?.();
            await reRenderAllVisiblePages(getVisibleRange, {
                preserveExistingPages: true,
                disableHorizontalAnchorRestore: mode === 'width' || shouldDisableHorizontalAnchorRestore(),
                rerenderSource: 'fit-mode',
                renderBufferOverride: 0,
            });
            syncHorizontalScrollAfterLayoutUpdate();
            if (pageToSnapTo === null) {
                await syncCurrentPageFromViewport({
                    source: 'fit-mode',
                    stabilize: true,
                });
            }
            if (pageToSnapTo !== null) {
                await nextTick();
                scrollToPage(pageToSnapTo, { preferExactDom: true });
                syncHorizontalScrollAfterLayoutUpdate();
            }
        }
    });

    watch(viewMode, async () => {
        if (!pdfDocument.value || isLoading.value) {
            return;
        }

        const pageToSnapTo = getMostVisiblePage(viewerContainer.value, numPages.value);
        resetContinuousScrollState();
        const updated = computeFitWidthScale(viewerContainer.value);
        if (updated) {
            setupPagePlaceholders();
        }

        cancelInFlightPageRenders?.();
        await reRenderAllVisiblePages(getVisibleRange, { disableHorizontalAnchorRestore: shouldDisableHorizontalAnchorRestore() });
        syncHorizontalScrollAfterLayoutUpdate();
        await nextTick();
        scrollToPage(pageToSnapTo);
        syncHorizontalScrollAfterLayoutUpdate();
    });

    watch(currentPage, async (next, previous) => {
        if (
            next === previous
            || fitMode.value !== 'width'
            || !isFitWidthZoomModeActive()
            || continuousScroll.value
            || !pdfDocument.value
            || isLoading.value
            || isResizing.value
        ) {
            return;
        }

        const updated = computeFitWidthScale(viewerContainer.value);
        syncHorizontalScrollAfterLayoutUpdate();
        if (!updated) {
            return;
        }

        const resizeAnchor = buildResizeAnchorContext({
            preferredAnchorPage: next,
            trustPreferredAnchorPage: true,
        });
        cancelInFlightPageRenders?.();
        await reRenderVisiblePagesAndSyncCurrentPage({
            source: 'fit-width-current-page',
            stabilize: true,
            resizeAnchor,
        });
    });

    watch(
        () => continuousScroll.value,
        async (next, previous) => {
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
            // Only snap on the continuous → single-page transition. Going
            // from single-page back to continuous keeps the user's existing
            // scrollTop, which is the correct "free reading" position for
            // continuous mode — snapping there would feel like a jump.
            if (
                previous === true
                && next === false
                && pdfDocument.value
                && !isLoading.value
            ) {
                await nextTick();
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
            cancelInFlightPageRenders?.();
            const zoomViewportAnchor = consumeZoomViewportAnchor?.() ?? null;
            const trustCurrentPageAnchor = !zoomViewportAnchor && canTrustCurrentPageAsZoomAnchor();
            const zoomAnchor = buildResizeAnchorContext({
                anchorViewportX: zoomViewportAnchor?.x ?? null,
                anchorViewportY: zoomViewportAnchor?.y ?? null,
                preferredAnchorPage: currentPage.value,
                trustPreferredAnchorPage: trustCurrentPageAnchor,
            });
            BrowserLogger.warnThrottled('pdf-zoom-debug', 'zoom-watch-schedule-rerender', ZOOM_QUEUE_LOG_THROTTLE_MS, '[zoom-watch] schedule zoom rerender', {
                previousZoom,
                nextZoom,
                consumedZoomViewportAnchor: zoomViewportAnchor,
                trustCurrentPageAnchor,
                builtZoomAnchor: zoomAnchor,
                viewer: summarizeViewerMetricsForLog(viewerContainer.value),
            });
            enqueueZoomSync({
                source: 'zoom-change',
                stabilize: true,
                resizeAnchor: zoomAnchor,
            });
        }
    });

    watch(isResizing, async (value) => {
        if (value || !pdfDocument.value || isLoading.value) {
            return;
        }

        await nextTick();
        await delay(20);
        const resizeAnchor = buildResizeAnchorContext();
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
