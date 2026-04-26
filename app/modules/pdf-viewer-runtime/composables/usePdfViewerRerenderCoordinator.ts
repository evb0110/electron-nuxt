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
    setupPagePlaceholders: () => void;
    scrollToPage: (pageNumber: number, options?: { preferExactDom?: boolean }) => void;
    getMostVisiblePage: (container: HTMLElement | null, numPages: number) => number;
    resetContinuousScrollState: () => void;
    resetZoomRerenderQueueState: (reason: string) => void;
    consumeZoomViewportAnchor?: () => IZoomViewportAnchor | null;
    beginResizeTransition: (source: string, anchorPage: number | null) => number;
    consumeSuppressedZoomRerender?: (nextZoom: number) => boolean;
}

export function usePdfViewerRerenderCoordinator(options: IUsePdfViewerRerenderCoordinatorOptions) {
    const {
        viewerContainer,
        pdfDocument,
        isLoading,
        numPages,
        currentPage,
        visibleRange,
        zoom,
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

    async function reRenderVisiblePagesAndSyncCurrentPage(
        syncOptions: ICurrentPageSyncOptions = {},
    ) {
        const source = syncOptions.source ?? 're-render';
        const runId = ++reRenderSyncRunId;
        if (source === 'zoom-change') {
            BrowserLogger.warn('pdf-zoom-debug', `[rerender-sync] begin zoom run=${runId}`, {
                runId,
                source,
                resizeAnchor: syncOptions.resizeAnchor ?? null,
                viewer: summarizeViewerMetricsForLog(viewerContainer.value),
            });
        }
        BrowserLogger.warn('pdf-nav', `[re-render-sync] begin run=${runId} source=${source}`, {
            runId,
            source,
            currentPage: currentPage.value,
            visibleRange: {
                start: visibleRange.value.start,
                end: visibleRange.value.end,
            },
            viewer: summarizeViewerMetricsForLog(viewerContainer.value),
        });
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
            rerenderSource: source,
            renderBufferOverride: resolveRerenderBufferOverride(source),
            maxCanvasPixelsOverride,
        });
        if (runId !== reRenderSyncRunId) {
            if (source === 'zoom-change') {
                BrowserLogger.warn('pdf-zoom-debug', `[rerender-sync] stale zoom run=${runId}`, {
                    runId,
                    activeRunId: reRenderSyncRunId,
                    viewer: summarizeViewerMetricsForLog(viewerContainer.value),
                });
            }
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

        if (source === 'zoom-change') {
            BrowserLogger.warn('pdf-zoom-debug', `[rerender-sync] end zoom run=${runId}`, {
                runId,
                viewer: summarizeViewerMetricsForLog(viewerContainer.value),
                visiblePageSnapshot: summarizeVisiblePageSnapshotForLog(viewerContainer.value),
            });
        }
        BrowserLogger.warn('pdf-nav', `[re-render-sync] end run=${runId} source=${source}`, {
            runId,
            source,
            currentPage: currentPage.value,
            visibleRange: {
                start: visibleRange.value.start,
                end: visibleRange.value.end,
            },
            viewer: summarizeViewerMetricsForLog(viewerContainer.value),
            visiblePageSnapshot: summarizeVisiblePageSnapshotForLog(viewerContainer.value),
        });
        await syncCurrentPageFromViewport(syncOptions);
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
                rerenderSource: 'fit-mode',
                renderBufferOverride: 0,
            });
            if (pageToSnapTo === null) {
                await syncCurrentPageFromViewport({
                    source: 'fit-mode',
                    stabilize: true,
                });
            }
            if (pageToSnapTo !== null) {
                await nextTick();
                scrollToPage(pageToSnapTo, { preferExactDom: true });
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
        await reRenderAllVisiblePages(getVisibleRange);
        await nextTick();
        scrollToPage(pageToSnapTo);
    });

    watch(
        () => continuousScroll.value,
        () => {
            resetContinuousScrollState();
            if (fitMode.value === 'height' && pdfDocument.value) {
                computeFitWidthScale(viewerContainer.value);
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
}
