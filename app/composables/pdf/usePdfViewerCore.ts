import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import {
    useDebounceFn,
    useEventListener,
    useResizeObserver,
} from '@vueuse/core';
import { PixelsPerInch } from 'pdfjs-dist';
import { BrowserLogger } from '@app/utils/browser-logger';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import { delay } from 'es-toolkit/promise';
import type {
    IAnnotationCommentSummary,
    IAnnotationSettings,
    TAnnotationTool,
} from '@app/types/annotations';
import type {
    PDFDocumentProxy,
    PDFPageProxy,
    TFitMode,
    TPdfViewMode,
    TPdfSource,
    IScrollSnapshot,
} from '@app/types/pdf';
import type { usePdfDocument } from '@app/composables/pdf/usePdfDocument';
import type { useAnnotationOrchestrator } from '@app/composables/pdf/annotations/useAnnotationOrchestrator';
import { runGuardedTask } from '@app/utils/async-guard';
import { getVisiblePageDebugSnapshot } from '@app/composables/pdf/pdfScrollVisibility';
import { captureScrollSnapshot } from '@app/composables/pdf/pdfPageRenderPipeline';

type TPdfDocumentResult = ReturnType<typeof usePdfDocument>;
type TAnnotationOrchestrator = ReturnType<typeof useAnnotationOrchestrator>;

interface IPageRange {
    start: number;
    end: number;
}

interface IUsePdfViewerCoreOptions {
    viewerContainer: Ref<HTMLElement | null>;
    src: ComputedRef<TPdfSource | null>;
    zoom: ComputedRef<number>;
    fitMode: ComputedRef<TFitMode>;
    viewMode: ComputedRef<TPdfViewMode>;
    isResizing: ComputedRef<boolean>;
    continuousScroll: ComputedRef<boolean>;
    annotationTool: ComputedRef<TAnnotationTool>;
    annotationCursorMode: ComputedRef<boolean>;
    annotationSettings: ComputedRef<IAnnotationSettings | null>;
    annotationUiManager: ShallowRef<AnnotationEditorUIManager | null>;
    annotationCommentsCache: Ref<IAnnotationCommentSummary[]>;
    activeCommentStableKey: Ref<string | null>;
    pdfDocumentResult: TPdfDocumentResult;
    annotations: TAnnotationOrchestrator;
    currentPage: Ref<number>;
    visibleRange: Ref<{
        start: number;
        end: number;
    }>;
    effectiveScale: Ref<number>;
    basePageWidth: Ref<number | null>;
    basePageHeight: Ref<number | null>;
    computeFitWidthScale: (container: HTMLElement | null) => boolean;
    resetScale: () => void;
    computeSkeletonInsets: (
        pdfPage: PDFPageProxy,
        renderVersion: number,
        getCurrentVersion: () => number,
    ) => Promise<void>;
    resetInsets: () => void;
    setupPagePlaceholders: () => void;
    renderVisiblePages: (
        range: IPageRange,
        options?: { preserveRenderedPages?: boolean },
    ) => Promise<void>;
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
    cancelInFlightPageRenders?: () => void;
    cleanupRenderedPages: () => void;
    invalidateRenderedPages: (pages: number[]) => void;
    applySearchHighlights: () => void;
    isPageRendered: (page: number) => boolean;
    getMostVisiblePage: (
        container: HTMLElement | null,
        numPages: number,
    ) => number;
    updateCurrentPage: (
        container: HTMLElement | null,
        numPages: number,
    ) => number;
    updateVisibleRange: (container: HTMLElement | null, numPages: number) => void;
    scrollToPage: (pageNumber: number, options?: { preferExactDom?: boolean; }) => void;
    resetContinuousScrollState: () => void;
    startDrag: (e: MouseEvent, container: HTMLElement | null) => void;
    onDrag: (e: MouseEvent, container: HTMLElement | null) => void;
    stopDrag: () => void;
    consumeZoomViewportAnchor?: () => IZoomViewportAnchor | null;
    isZoomInteractionLocked?: () => boolean;
    isZoomGestureSessionLocked?: () => boolean;
    setZoomRerenderBusy?: (busy: boolean) => void;
    setResizeTransitionVisible?: (payload: IResizeTransitionSignal) => void;
    emit: {
        (e: 'update:zoom', value: number): void;
        (e: 'update:currentPage', page: number): void;
        (e: 'update:totalPages', total: number): void;
        (e: 'update:loading', loading: boolean): void;
        (e: 'update:document', document: PDFDocumentProxy | null): void;
        (e: 'loading', loading: boolean): void;
        (e: 'annotation-comments', comments: IAnnotationCommentSummary[]): void;
        (e: 'annotation-modified'): void;
    };
}

interface IResizeTransitionSignal {
    active: boolean;
    source: string;
    token: number;
    anchorPage: number | null;
}

interface ICurrentPageSyncOptions {
    source?: string;
    stabilize?: boolean;
    resizeAnchor?: IResizeAnchorContext | null;
}

interface IResizeAnchorContext {
    capturedAtMs: number;
    page: number;
    transitionToken: number;
    snapshot: IScrollSnapshot | null;
    visibleRange: {
        start: number;
        end: number;
    };
    viewerMetrics: ReturnType<typeof summarizeViewerMetrics>;
}

interface IZoomViewportAnchor {
    id?: number;
    sessionId?: number;
    x: number;
    y: number;
    capturedAtMs: number;
}

function isResizeSource(source: string) {
    return source === 'resize-observer' || source === 'resize-settle';
}

function summarizeViewerMetrics(container: HTMLElement | null) {
    if (!container) {
        return null;
    }
    return {
        scrollTop: Math.round(container.scrollTop),
        scrollLeft: Math.round(container.scrollLeft),
        clientWidth: Math.round(container.clientWidth),
        clientHeight: Math.round(container.clientHeight),
        scrollWidth: Math.round(container.scrollWidth),
        scrollHeight: Math.round(container.scrollHeight),
    };
}

export const usePdfViewerCore = (options: IUsePdfViewerCoreOptions) => {
    const {
        viewerContainer,
        src,
        zoom,
        fitMode,
        viewMode,
        isResizing,
        continuousScroll,
        annotationTool,
        annotationCursorMode,
        annotationSettings,
        annotationUiManager,
        annotationCommentsCache,
        activeCommentStableKey,
        pdfDocumentResult,
        annotations,
        currentPage,
        visibleRange,
        effectiveScale,
        basePageWidth,
        basePageHeight,
        computeFitWidthScale,
        resetScale,
        computeSkeletonInsets,
        resetInsets,
        setupPagePlaceholders,
        renderVisiblePages,
        reRenderAllVisiblePages,
        cancelInFlightPageRenders,
        cleanupRenderedPages,
        invalidateRenderedPages,
        applySearchHighlights,
        isPageRendered,
        getMostVisiblePage,
        updateCurrentPage,
        updateVisibleRange,
        scrollToPage,
        resetContinuousScrollState,
        startDrag,
        onDrag,
        consumeZoomViewportAnchor,
        isZoomInteractionLocked,
        isZoomGestureSessionLocked,
        setZoomRerenderBusy,
        setResizeTransitionVisible,
        emit,
    } = options;

    const {
        pdfDocument,
        numPages,
        isLoading,
        getRenderVersion,
        loadPdf,
        getPage,
        cleanup: cleanupDocument,
    } = pdfDocumentResult;

    const {
        editor,
        commentSync,
        inlineIndicators,
        highlight,
    } = annotations;

    const SKELETON_BUFFER = 3;
    const CURRENT_PAGE_SYNC_SAMPLE_COUNT = 3;
    const ZOOM_QUEUE_LOG_THROTTLE_MS = 420;
    const ZOOM_RERENDER_DEFER_WHILE_GESTURE_MS = 80;
    const ZOOM_RERENDER_DURING_GESTURE_MIN_INTERVAL_MS = 110;
    const ZOOM_GESTURE_MAX_CANVAS_PIXELS = 14_000_000;
    let reRenderSyncRunId = 0;
    let currentPageSyncRunId = 0;
    let currentPageEmitEventId = 0;
    let resizeTransitionToken = 0;
    let pendingResizeTransitionHideTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingZoomSyncOptions: ICurrentPageSyncOptions | null = null;
    let zoomRerenderFrameScheduled = false;
    let zoomRerenderDeferredTimer: ReturnType<typeof setTimeout> | null = null;
    let zoomRerenderQueueProcessing = false;
    let lastZoomRerenderFrameAtMs = 0;
    let zoomGestureLowResRerenderUsed = false;
    let zoomSettleCheckTimer: ReturnType<typeof setTimeout> | null = null;
    let deferredResizeSyncAfterZoom: {
        stage: string;
        syncOptions: ICurrentPageSyncOptions;
    } | null = null;
    let lastReportedZoomBusy = false;

    function isZoomRerenderBusy() {
        return zoomRerenderQueueProcessing
            || zoomRerenderFrameScheduled
            || zoomRerenderDeferredTimer !== null
            || pendingZoomSyncOptions !== null;
    }

    function clearZoomRerenderDeferredTimer() {
        if (zoomRerenderDeferredTimer !== null) {
            clearTimeout(zoomRerenderDeferredTimer);
            zoomRerenderDeferredTimer = null;
        }
    }

    function clearZoomSettleCheckTimer() {
        if (zoomSettleCheckTimer !== null) {
            clearTimeout(zoomSettleCheckTimer);
            zoomSettleCheckTimer = null;
        }
    }

    function scheduleZoomSettleRerenderIfNeeded() {
        if (!zoomGestureLowResRerenderUsed || pendingZoomSyncOptions) {
            return;
        }
        if (!pdfDocument.value || isLoading.value) {
            return;
        }
        const gestureSessionLocked = isZoomGestureSessionLocked?.() ?? false;
        if (gestureSessionLocked) {
            if (zoomSettleCheckTimer !== null) {
                return;
            }
            zoomSettleCheckTimer = setTimeout(() => {
                zoomSettleCheckTimer = null;
                scheduleZoomSettleRerenderIfNeeded();
            }, ZOOM_RERENDER_DEFER_WHILE_GESTURE_MS);
            return;
        }

        zoomGestureLowResRerenderUsed = false;
        pendingZoomSyncOptions = {
            source: 'zoom-settle',
            stabilize: true,
            resizeAnchor: buildResizeAnchorContext(),
        };
        reportZoomBusyStateIfChanged('zoom-settle-enqueue');
        scheduleZoomRerender();
    }

    function resetZoomRerenderQueueState(reason: string) {
        pendingZoomSyncOptions = null;
        clearZoomRerenderDeferredTimer();
        clearZoomSettleCheckTimer();
        zoomGestureLowResRerenderUsed = false;
        BrowserLogger.warnThrottled(
            'pdf-zoom-debug',
            'zoom-queue-reset',
            ZOOM_QUEUE_LOG_THROTTLE_MS,
            '[zoom-queue] reset',
            { reason },
        );
        reportZoomBusyStateIfChanged(`reset:${reason}`);
    }

    function deferZoomRerenderWhileGestureActive() {
        if (zoomRerenderDeferredTimer !== null) {
            return false;
        }
        reportZoomBusyStateIfChanged('gesture-locked-defer-scheduled');
        zoomRerenderDeferredTimer = setTimeout(() => {
            zoomRerenderDeferredTimer = null;
            reportZoomBusyStateIfChanged('gesture-locked-defer-fired');
            if (!pendingZoomSyncOptions) {
                return;
            }
            scheduleZoomRerender();
        }, ZOOM_RERENDER_DEFER_WHILE_GESTURE_MS);
        return true;
    }

    function reportZoomBusyStateIfChanged(source: string) {
        const busy = isZoomRerenderBusy();
        if (busy === lastReportedZoomBusy) {
            return;
        }
        lastReportedZoomBusy = busy;
        BrowserLogger.warnThrottled('pdf-zoom-debug', 'zoom-queue-busy', ZOOM_QUEUE_LOG_THROTTLE_MS, `[zoom-queue] busy=${busy}`, {
            source,
            busy,
            frameScheduled: zoomRerenderFrameScheduled,
            queueProcessing: zoomRerenderQueueProcessing,
            hasPendingZoomSync: Boolean(pendingZoomSyncOptions),
        });
        setZoomRerenderBusy?.(busy);
    }

    function deferResizeRerenderUntilZoomSettles(
        stage: string,
        syncOptions: ICurrentPageSyncOptions,
    ) {
        deferredResizeSyncAfterZoom = {
            stage,
            syncOptions,
        };
        BrowserLogger.warnThrottled('pdf-zoom-debug', 'zoom-queue-defer-resize', ZOOM_QUEUE_LOG_THROTTLE_MS, '[zoom-queue] deferred resize rerender while zoom busy', {
            stage,
            source: syncOptions.source ?? 'unknown',
            hasResizeAnchor: Boolean(syncOptions.resizeAnchor),
            zoomBusy: isZoomRerenderBusy(),
        });
    }

    function flushDeferredResizeRerender(source: string) {
        if (isZoomRerenderBusy() || !deferredResizeSyncAfterZoom) {
            return;
        }
        const deferred = deferredResizeSyncAfterZoom;
        deferredResizeSyncAfterZoom = null;
        BrowserLogger.warnThrottled('pdf-zoom-debug', 'zoom-queue-flush-deferred-resize', ZOOM_QUEUE_LOG_THROTTLE_MS, '[zoom-queue] flush deferred resize rerender', {
            source,
            stage: deferred.stage,
            syncSource: deferred.syncOptions.source ?? 'unknown',
        });
        runGuardedTask(() => reRenderVisiblePagesAndSyncCurrentPage(deferred.syncOptions), {
            scope: 'pdf-viewer',
            message: `Failed to ${deferred.stage} (deferred until zoom settled)`,
        });
    }

    function emitResizeTransitionSignal(
        active: boolean,
        source: string,
        token: number,
        anchorPage: number | null,
    ) {
        setResizeTransitionVisible?.({
            active,
            source,
            token,
            anchorPage,
        });
    }

    function beginResizeTransition(source: string, anchorPage: number | null) {
        resizeTransitionToken += 1;
        const token = resizeTransitionToken;
        if (pendingResizeTransitionHideTimer !== null) {
            clearTimeout(pendingResizeTransitionHideTimer);
            pendingResizeTransitionHideTimer = null;
        }
        emitResizeTransitionSignal(true, source, token, anchorPage);
        return token;
    }

    function scheduleEndResizeTransition(
        token: number,
        source: string,
        anchorPage: number | null,
    ) {
        if (pendingResizeTransitionHideTimer !== null) {
            clearTimeout(pendingResizeTransitionHideTimer);
        }
        pendingResizeTransitionHideTimer = setTimeout(() => {
            if (token !== resizeTransitionToken) {
                return;
            }
            emitResizeTransitionSignal(false, source, token, anchorPage);
            pendingResizeTransitionHideTimer = null;
        }, 90);
    }

    function isPageNearVisible(page: number) {
        const start = Math.max(1, visibleRange.value.start - SKELETON_BUFFER);
        const end = Math.min(
            numPages.value,
            visibleRange.value.end + SKELETON_BUFFER,
        );
        return page >= start && page <= end;
    }

    function shouldShowSkeleton(page: number) {
        return isPageNearVisible(page) && !isPageRendered(page);
    }

    function handleDragStart(e: MouseEvent) {
        startDrag(e, viewerContainer.value);
    }
    function handleDragMove(e: MouseEvent) {
        onDrag(e, viewerContainer.value);
    }

    function getVisibleRange() {
        updateVisibleRange(viewerContainer.value, numPages.value);
        return visibleRange.value;
    }

    function hasRenderedPageCanvas() {
        const container = viewerContainer.value;
        if (!container) {
            return false;
        }
        return Boolean(
            container.querySelector('.page_container .page_canvas canvas'),
        );
    }

    function hasRenderedTextLayerContent() {
        const container = viewerContainer.value;
        if (!container) {
            return false;
        }
        return Boolean(
            container.querySelector(
                '.page_container .text-layer span, .page_container .textLayer span',
            ),
        );
    }

    function logAsyncStageError(stage: string, error: unknown) {
        BrowserLogger.error('pdf-viewer', `Failed to ${stage}`, error);
    }

    function scheduleRecoverInitialRender() {
        runGuardedTask(() => recoverInitialRenderIfNeeded(), {
            scope: 'pdf-viewer',
            message: 'Failed to recover initial PDF render',
        });
    }

    function scheduleReRenderVisiblePages(
        stage: string,
        syncOptions: ICurrentPageSyncOptions = {},
    ) {
        const source = syncOptions.source ?? 're-render';
        if (isResizeSource(source) && isZoomRerenderBusy()) {
            deferResizeRerenderUntilZoomSettles(stage, syncOptions);
            return;
        }
        runGuardedTask(() => reRenderVisiblePagesAndSyncCurrentPage(syncOptions), {
            scope: 'pdf-viewer',
            message: `Failed to ${stage}`,
        });
    }

    async function processPendingZoomRerenderQueue() {
        if (zoomRerenderQueueProcessing) {
            BrowserLogger.warnThrottled('pdf-zoom-debug', 'zoom-queue-skip-while-busy', ZOOM_QUEUE_LOG_THROTTLE_MS, '[zoom-queue] skip process while busy');
            return;
        }

        zoomRerenderQueueProcessing = true;
        reportZoomBusyStateIfChanged('queue-start');
        try {
            while (pendingZoomSyncOptions) {
                if (!pdfDocument.value || isLoading.value) {
                    BrowserLogger.warnThrottled('pdf-zoom-debug', 'zoom-queue-clear-pending-not-ready', ZOOM_QUEUE_LOG_THROTTLE_MS, '[zoom-queue] clear pending because document not ready', {
                        hasDocument: Boolean(pdfDocument.value),
                        isLoading: isLoading.value,
                    });
                    pendingZoomSyncOptions = null;
                    break;
                }

                const nextSyncOptions = pendingZoomSyncOptions;
                pendingZoomSyncOptions = null;
                BrowserLogger.warnThrottled('pdf-zoom-debug', 'zoom-queue-run-next-sync-option', ZOOM_QUEUE_LOG_THROTTLE_MS, '[zoom-queue] run next sync option', {
                    source: nextSyncOptions.source ?? 'unknown',
                    hasResizeAnchor: Boolean(nextSyncOptions.resizeAnchor),
                    anchorPage: nextSyncOptions.resizeAnchor?.page ?? null,
                    anchorCapturedAtMs: nextSyncOptions.resizeAnchor?.capturedAtMs ?? null,
                    viewer: summarizeViewerMetricsForLog(viewerContainer.value),
                });
                await reRenderVisiblePagesAndSyncCurrentPage(nextSyncOptions);
            }
        } finally {
            zoomRerenderQueueProcessing = false;
            if (pendingZoomSyncOptions) {
                BrowserLogger.warnThrottled('pdf-zoom-debug', 'zoom-queue-pending-remains', ZOOM_QUEUE_LOG_THROTTLE_MS, '[zoom-queue] pending remains after processing; schedule again');
                scheduleZoomRerender();
            }
            scheduleZoomSettleRerenderIfNeeded();
            reportZoomBusyStateIfChanged('queue-end');
            flushDeferredResizeRerender('zoom-queue-drained');
        }
    }

    function scheduleZoomRerender() {
        const isGestureLocked = isZoomInteractionLocked?.() ?? false;
        if (isGestureLocked) {
            const nowMs = Date.now();
            const elapsedSinceLastFrameMs = nowMs - lastZoomRerenderFrameAtMs;
            const shouldThrottleDuringGesture = lastZoomRerenderFrameAtMs > 0
                && elapsedSinceLastFrameMs < ZOOM_RERENDER_DURING_GESTURE_MIN_INTERVAL_MS;
            if (shouldThrottleDuringGesture) {
                const deferScheduled = deferZoomRerenderWhileGestureActive();
                if (deferScheduled) {
                    BrowserLogger.warnThrottled('pdf-zoom-debug', 'zoom-queue-defer-while-gesture-active', ZOOM_QUEUE_LOG_THROTTLE_MS, '[zoom-queue] defer while gesture active', {
                        throttleIntervalMs: ZOOM_RERENDER_DURING_GESTURE_MIN_INTERVAL_MS,
                        elapsedSinceLastFrameMs,
                    });
                }
                return;
            }
            BrowserLogger.warnThrottled('pdf-zoom-debug', 'zoom-queue-allow-during-gesture', ZOOM_QUEUE_LOG_THROTTLE_MS, '[zoom-queue] allow frame while gesture active', {
                throttleIntervalMs: ZOOM_RERENDER_DURING_GESTURE_MIN_INTERVAL_MS,
                elapsedSinceLastFrameMs: lastZoomRerenderFrameAtMs > 0
                    ? elapsedSinceLastFrameMs
                    : null,
            });
        } else {
            lastZoomRerenderFrameAtMs = 0;
        }
        clearZoomRerenderDeferredTimer();
        if (zoomRerenderFrameScheduled) {
            BrowserLogger.warnThrottled('pdf-zoom-debug', 'zoom-queue-frame-already-scheduled', ZOOM_QUEUE_LOG_THROTTLE_MS, '[zoom-queue] frame already scheduled');
            return;
        }
        zoomRerenderFrameScheduled = true;
        reportZoomBusyStateIfChanged('frame-scheduled');
        BrowserLogger.warnThrottled('pdf-zoom-debug', 'zoom-queue-schedule-frame', ZOOM_QUEUE_LOG_THROTTLE_MS, '[zoom-queue] schedule frame');
        runGuardedTask(async () => {
            await waitForAnimationFrame();
            zoomRerenderFrameScheduled = false;
            lastZoomRerenderFrameAtMs = Date.now();
            reportZoomBusyStateIfChanged('frame-fired');
            BrowserLogger.warnThrottled('pdf-zoom-debug', 'zoom-queue-frame-fired', ZOOM_QUEUE_LOG_THROTTLE_MS, '[zoom-queue] frame fired');
            await processPendingZoomRerenderQueue();
        }, {
            scope: 'pdf-viewer',
            message: 'Failed to re-render visible pages after zoom change',
        });
    }

    function scheduleLoadFromSource(isReload = false) {
        runGuardedTask(() => loadFromSource(isReload), {
            scope: 'pdf-viewer',
            message: 'Failed to load PDF source',
        });
    }

    function scheduleSetAnnotationTool(tool: TAnnotationTool, stage: string) {
        runGuardedTask(() => editor.setAnnotationTool(tool), {
            scope: 'pdf-viewer',
            message: `Failed to ${stage}`,
        });
    }

    function waitForAnimationFrame() {
        return new Promise<void>((resolve) => {
            if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
                setTimeout(() => resolve(), 16);
                return;
            }
            window.requestAnimationFrame(() => resolve());
        });
    }

    function summarizeViewerMetricsForLog(container: HTMLElement | null) {
        return summarizeViewerMetrics(container);
    }

    function summarizeVisiblePageSnapshotForLog(container: HTMLElement | null) {
        if (!container || numPages.value <= 0) {
            return null;
        }
        return getVisiblePageDebugSnapshot(container, numPages.value, 8).map((entry) => ({
            pageNumber: entry.pageNumber,
            visibleHeight: Math.round(entry.visibleHeight),
            pageTop: Math.round(entry.pageTop),
            pageBottom: Math.round(entry.pageBottom),
            pageHeight: Math.round(entry.pageHeight),
        }));
    }

    function buildSyncSummaryLine(
        source: string,
        previous: number,
        next: number,
        changed: boolean,
        fallbackToCurrent: boolean,
        samples: number[] | null,
    ) {
        const sampleText = samples && samples.length > 0
            ? samples.join(',')
            : 'none';
        return `[sync] source=${source} prev=${previous} next=${next}`
            + ` changed=${changed} fallback=${fallbackToCurrent}`
            + ` samples=${sampleText}`
            + ` range=${visibleRange.value.start}-${visibleRange.value.end}`;
    }

    function shouldPreserveExistingPagesDuringRerender(source: string) {
        return source === 'zoom-change' || source === 'zoom-settle' || source === 'fit-mode';
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
        const gestureSessionLocked = isZoomGestureSessionLocked?.() ?? false;
        if (!gestureSessionLocked) {
            return undefined;
        }
        return ZOOM_GESTURE_MAX_CANVAS_PIXELS;
    }

    function pickMostFrequentPage(pages: number[]) {
        const counts = new Map<number, number>();
        for (const page of pages) {
            counts.set(page, (counts.get(page) ?? 0) + 1);
        }
        let winner: number | null = null;
        let maxCount = 0;
        for (const page of pages) {
            const count = counts.get(page) ?? 0;
            if (count > maxCount) {
                winner = page;
                maxCount = count;
            }
        }
        return {
            page: winner,
            count: maxCount,
        };
    }

    function emitCurrentPageIfChanged(
        page: number,
        source: string,
        samples: number[] | null,
        fallbackToCurrent: boolean,
    ) {
        const previous = currentPage.value;
        const changed = page !== previous;
        const hasSampleDrift = Boolean(samples && new Set(samples).size > 1);
        const shouldLog = changed || hasSampleDrift || fallbackToCurrent || source.includes('resize');
        const eventId = ++currentPageEmitEventId;

        if (shouldLog) {
            BrowserLogger.warn(
                'pdf-nav',
                `${buildSyncSummaryLine(source, previous, page, changed, fallbackToCurrent, samples)} eventId=${eventId}`,
                {
                    source,
                    eventId,
                    previousPage: previous,
                    nextPage: page,
                    changed,
                    fallbackToCurrent,
                    samples,
                    currentVisibleRange: {
                        start: visibleRange.value.start,
                        end: visibleRange.value.end,
                    },
                    viewer: summarizeViewerMetricsForLog(viewerContainer.value),
                    visiblePageSnapshot: summarizeVisiblePageSnapshotForLog(viewerContainer.value),
                    stack: (() => {
                        try {
                            return (new Error('viewport-current-page-sync'))
                                .stack
                                ?.split('\n')
                                .slice(1, 5)
                                .map(entry => entry.trim());
                        } catch {
                            return null;
                        }
                    })(),
                });
        }

        if (!changed) {
            return;
        }
        currentPage.value = page;
        emit('update:currentPage', page);
    }

    async function resolveStableCurrentPageFromViewport(syncRunId: number, source: string) {
        const container = viewerContainer.value;
        if (!container || numPages.value <= 0) {
            return null;
        }

        const samples: number[] = [];
        for (
            let sampleIndex = 0;
            sampleIndex < CURRENT_PAGE_SYNC_SAMPLE_COUNT;
            sampleIndex += 1
        ) {
            if (syncRunId !== currentPageSyncRunId) {
                return null;
            }
            const sampledPage = getMostVisiblePage(container, numPages.value);
            samples.push(sampledPage);
            BrowserLogger.warn(
                'pdf-nav',
                `[sync-sample] source=${source} run=${syncRunId}`
                + ` sample=${sampleIndex + 1}/${CURRENT_PAGE_SYNC_SAMPLE_COUNT}`
                + ` page=${sampledPage}`,
                {
                    source,
                    syncRunId,
                    sampleIndex,
                    sampledPage,
                    currentPage: currentPage.value,
                    visibleRange: {
                        start: visibleRange.value.start,
                        end: visibleRange.value.end,
                    },
                    viewer: summarizeViewerMetricsForLog(container),
                    visiblePageSnapshot: summarizeVisiblePageSnapshotForLog(container),
                },
            );
            if (sampleIndex + 1 < CURRENT_PAGE_SYNC_SAMPLE_COUNT) {
                await nextTick();
                await waitForAnimationFrame();
            }
        }

        const picked = pickMostFrequentPage(samples);
        if (picked.page === null) {
            return null;
        }

        if (picked.count <= 1) {
            return {
                page: currentPage.value,
                samples,
                fallbackToCurrent: true,
            };
        }

        return {
            page: picked.page,
            samples,
            fallbackToCurrent: false,
        };
    }

    async function syncCurrentPageFromViewport(options: ICurrentPageSyncOptions = {}) {
        if (!pdfDocument.value || isLoading.value || numPages.value <= 0) {
            return;
        }

        const source = options.source ?? 'default';
        if (options.resizeAnchor && isResizeSource(source)) {
            BrowserLogger.warn(
                'pdf-nav',
                `[resize-anchor] fixed current-page sync source=${source}`
                + ` page=${options.resizeAnchor.page}`
                + ` token=${options.resizeAnchor.transitionToken}`,
                {
                    source,
                    page: options.resizeAnchor.page,
                    transitionToken: options.resizeAnchor.transitionToken,
                    capturedAtMs: options.resizeAnchor.capturedAtMs,
                    capturedVisibleRange: options.resizeAnchor.visibleRange,
                    capturedViewerMetrics: options.resizeAnchor.viewerMetrics,
                    viewer: summarizeViewerMetricsForLog(viewerContainer.value),
                    visiblePageSnapshot: summarizeVisiblePageSnapshotForLog(viewerContainer.value),
                },
            );
            emitCurrentPageIfChanged(
                options.resizeAnchor.page,
                `${source}:anchor-fixed`,
                null,
                false,
            );
            return;
        }
        const syncRunId = ++currentPageSyncRunId;
        if (options.stabilize) {
            const stablePage = await resolveStableCurrentPageFromViewport(syncRunId, source);
            if (!stablePage || syncRunId !== currentPageSyncRunId) {
                return;
            }

            emitCurrentPageIfChanged(
                stablePage.page,
                source,
                stablePage.samples,
                stablePage.fallbackToCurrent,
            );
            return;
        }

        const page = updateCurrentPage(viewerContainer.value, numPages.value);
        emitCurrentPageIfChanged(page, source, null, false);
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
        const maxCanvasPixelsOverride = resolveMaxCanvasPixelsOverride(source);
        if (maxCanvasPixelsOverride !== undefined) {
            zoomGestureLowResRerenderUsed = true;
        }
        await reRenderAllVisiblePages(getVisibleRange, {
            preserveExistingPages: shouldPreserveExistingPagesDuringRerender(source),
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

    async function recoverInitialRenderIfNeeded() {
        if (!pdfDocument.value || isLoading.value || numPages.value <= 0) {
            return;
        }
        if (hasRenderedPageCanvas() || hasRenderedTextLayerContent()) {
            return;
        }
        await nextTick();
        await delay(40);
        if (hasRenderedPageCanvas() || hasRenderedTextLayerContent()) {
            return;
        }

        updateVisibleRange(viewerContainer.value, numPages.value);
        try {
            await reRenderVisiblePagesAndSyncCurrentPage();
        } catch (error) {
            logAsyncStageError(
                're-render visible pages during initial recovery',
                error,
            );
        }

        await nextTick();
        await delay(80);
        if (hasRenderedPageCanvas() || hasRenderedTextLayerContent()) {
            return;
        }

        updateVisibleRange(viewerContainer.value, numPages.value);
        try {
            await renderVisiblePages(getVisibleRange());
            await syncCurrentPageFromViewport({ source: 'recover-initial-render' });
        } catch (error) {
            logAsyncStageError('render visible pages during initial recovery', error);
        }
    }

    let pendingInvalidation: number[] | null = null;
    function invalidatePages(pages: number[]) {
        pendingInvalidation = pages;
    }

    async function loadFromSource(isReload = false) {
        if (!src.value) {
            commentSync.incrementSyncToken();
            annotationCommentsCache.value = [];
            activeCommentStableKey.value = null;
            emit('annotation-comments', []);
            return;
        }

        const pageToRestore = isReload ? currentPage.value : 1;
        const pagesToInvalidate = pendingInvalidation;
        pendingInvalidation = null;
        const isSelectiveReload = isReload && pagesToInvalidate !== null;

        const savedBaseWidth = isSelectiveReload ? basePageWidth.value : null;
        const savedBaseHeight = isSelectiveReload ? basePageHeight.value : null;
        const savedVisibleRange = isSelectiveReload
            ? { ...visibleRange.value }
            : null;

        emit('update:document', null);
        if (!isReload) emit('update:totalPages', 0);
        emit('update:currentPage', pageToRestore);

        if (isSelectiveReload && pagesToInvalidate) {
            invalidateRenderedPages(pagesToInvalidate);
        } else {
            cleanupRenderedPages();
            resetScale();
            resetInsets();
            currentPage.value = pageToRestore;
            visibleRange.value = {
                start: pageToRestore,
                end: pageToRestore,
            };
        }
        editor.destroyAnnotationEditor();

        const loaded = await loadPdf(
            src.value,
            isSelectiveReload ? { preservePageStructure: true } : undefined,
        );
        if (!loaded) {
            return;
        }

        if (
            isSelectiveReload &&
      savedBaseWidth !== null &&
      savedBaseHeight !== null
        ) {
            basePageWidth.value = savedBaseWidth;
            basePageHeight.value = savedBaseHeight;
        }

        emit('update:document', pdfDocument.value);
        editor.initAnnotationEditor();

        currentPage.value = Math.min(pageToRestore, numPages.value);
        emit('update:totalPages', numPages.value);
        emit('update:currentPage', currentPage.value);

        if (!isSelectiveReload) {
            runGuardedTask(
                async () => {
                    const firstPage = await getPage(1);
                    await computeSkeletonInsets(
                        firstPage,
                        loaded.version,
                        getRenderVersion,
                    );
                },
                {
                    scope: 'pdf-viewer',
                    message: 'Failed to compute PDF skeleton insets',
                },
            );
        }

        await nextTick();

        if (!isSelectiveReload) {
            computeFitWidthScale(viewerContainer.value);
            setupPagePlaceholders();
            if (isReload && currentPage.value > 1) {
                scrollToPage(currentPage.value);
                await nextTick();
            }
        } else if (savedVisibleRange) {
            visibleRange.value = savedVisibleRange;
        }

        updateVisibleRange(viewerContainer.value, numPages.value);
        try {
            await renderVisiblePages(visibleRange.value);
            await syncCurrentPageFromViewport({ source: 'load-from-source' });
        } catch (error) {
            logAsyncStageError('render visible pages after source load', error);
        }
        applySearchHighlights();
        commentSync.scheduleAnnotationCommentsSync(true);
        scheduleRecoverInitialRender();
    }

    function undoAnnotation() {
        annotationUiManager.value?.undo();
    }
    function redoAnnotation() {
        annotationUiManager.value?.redo();
    }

    const debouncedRenderOnResize = useDebounceFn(() => {
        if (isLoading.value || !pdfDocument.value) {
            return;
        }
        scheduleReRenderVisiblePages(
            're-render visible pages after resize',
            {
                source: 'resize-observer',
                stabilize: true,
            },
        );
    }, 200);

    function buildResizeAnchorContext(optionsOverride?: {
        anchorViewportX?: number | null;
        anchorViewportY?: number | null;
    }) {
        const snapshot = captureScrollSnapshot(viewerContainer.value, optionsOverride);
        const snapshotAnchorPage =
            snapshot
            && typeof snapshot.anchorPage === 'number'
            && Number.isFinite(snapshot.anchorPage)
                ? snapshot.anchorPage
                : null;
        const mostVisiblePage = snapshotAnchorPage ?? getMostVisiblePage(viewerContainer.value, numPages.value);
        BrowserLogger.warnThrottled('pdf-zoom-debug', 'anchor-build-captured', ZOOM_QUEUE_LOG_THROTTLE_MS, '[anchor-build] captured', {
            optionsOverride: optionsOverride ?? null,
            snapshotAnchorPage,
            mostVisiblePage,
            snapshot,
            viewer: summarizeViewerMetricsForLog(viewerContainer.value),
        });
        return {
            capturedAtMs: Date.now(),
            page: mostVisiblePage,
            transitionToken: 0,
            snapshot,
            visibleRange: {
                start: visibleRange.value.start,
                end: visibleRange.value.end,
            },
            viewerMetrics: summarizeViewerMetricsForLog(viewerContainer.value),
        } satisfies IResizeAnchorContext;
    }

    let pendingResizeAnchor: IResizeAnchorContext | null = null;

    const debouncedRenderOnResizeWithAnchor = useDebounceFn(() => {
        if (isLoading.value || !pdfDocument.value) {
            if (pendingResizeAnchor) {
                scheduleEndResizeTransition(
                    pendingResizeAnchor.transitionToken,
                    'resize-cancelled',
                    pendingResizeAnchor.page,
                );
            }
            pendingResizeAnchor = null;
            return;
        }
        const anchor = pendingResizeAnchor;
        pendingResizeAnchor = null;
        scheduleReRenderVisiblePages(
            're-render visible pages after resize',
            {
                source: 'resize-observer',
                stabilize: true,
                resizeAnchor: anchor,
            },
        );
    }, 200);

    function handleResize() {
        if (isLoading.value || isResizing.value) {
            return;
        }
        const resizeAnchor = buildResizeAnchorContext();
        const updated = computeFitWidthScale(viewerContainer.value);
        if (updated && pdfDocument.value) {
            const transitionToken = beginResizeTransition(
                'resize-observer',
                resizeAnchor.page,
            );
            const anchoredResizeContext: IResizeAnchorContext = {
                ...resizeAnchor,
                transitionToken,
            };
            pendingResizeAnchor = anchoredResizeContext;
            BrowserLogger.warn('pdf-nav', 'Resize observer requested re-render'
                + ` anchorPage=${anchoredResizeContext.page}`
                + ` anchorRange=${anchoredResizeContext.visibleRange.start}-${anchoredResizeContext.visibleRange.end}`
                + ` token=${anchoredResizeContext.transitionToken}`, {
                currentPage: currentPage.value,
                visibleRange: {
                    start: visibleRange.value.start,
                    end: visibleRange.value.end,
                },
                anchorSnapshot: anchoredResizeContext.snapshot,
                anchorViewerMetrics: anchoredResizeContext.viewerMetrics,
                pendingAnchorPage: pendingResizeAnchor.page,
                pendingAnchorAgeMs: Date.now() - pendingResizeAnchor.capturedAtMs,
                viewer: summarizeViewerMetricsForLog(viewerContainer.value),
                visiblePageSnapshot: summarizeVisiblePageSnapshotForLog(viewerContainer.value),
            });
            debouncedRenderOnResizeWithAnchor();
        } else {
            debouncedRenderOnResize();
        }
    }

    useResizeObserver(viewerContainer, handleResize);

    const documentTarget = typeof document !== 'undefined' ? document : null;
    useEventListener(
        documentTarget,
        'selectionchange',
        highlight.cacheCurrentTextSelection,
        { passive: true },
    );
    useEventListener(
        documentTarget,
        'pointerup',
        highlight.handleDocumentPointerUp,
        { passive: true },
    );

    onMounted(() => {
        inlineIndicators.attachInlineCommentMarkerObserver();
        scheduleLoadFromSource();
    });

    onUnmounted(() => {
        pendingZoomSyncOptions = null;
        clearZoomRerenderDeferredTimer();
        clearZoomSettleCheckTimer();
        zoomRerenderFrameScheduled = false;
        zoomRerenderQueueProcessing = false;
        lastZoomRerenderFrameAtMs = 0;
        zoomGestureLowResRerenderUsed = false;
        deferredResizeSyncAfterZoom = null;
        lastReportedZoomBusy = false;
        setZoomRerenderBusy?.(false);
        if (pendingResizeTransitionHideTimer !== null) {
            clearTimeout(pendingResizeTransitionHideTimer);
            pendingResizeTransitionHideTimer = null;
        }
        emitResizeTransitionSignal(false, 'unmount', resizeTransitionToken, currentPage.value);
        inlineIndicators.cleanup();
        highlight.clearSelectionCache();
        cleanupRenderedPages();
        editor.destroyAnnotationEditor();
        cleanupDocument();
        annotationCommentsCache.value = [];
        activeCommentStableKey.value = null;
        emit('annotation-comments', []);
    });

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

    watch(src, (newSrc, oldSrc) => {
        if (newSrc !== oldSrc) {
            const isReload = !!oldSrc && !!newSrc;
            if (!newSrc) {
                emit('update:document', null);
                annotationCommentsCache.value = [];
                activeCommentStableKey.value = null;
                emit('annotation-comments', []);
            }
            scheduleLoadFromSource(isReload);
        }
    });

    const annotationCommentStableKeys = computed(() =>
        annotationCommentsCache.value.map(comment => comment.stableKey),
    );
    watch(
        annotationCommentStableKeys,
        (stableKeys) => {
            const activeKey = activeCommentStableKey.value;
            if (!activeKey) {
                return;
            }
            if (!stableKeys.includes(activeKey)) {
                activeCommentStableKey.value = null;
            }
        },
    );

    watch(
        () => continuousScroll.value,
        () => {
            resetContinuousScrollState();
        },
    );

    watch(zoom, (nextZoom, previousZoom) => {
        if (pdfDocument.value) {
            clearZoomSettleCheckTimer();
            cancelInFlightPageRenders?.();
            const zoomViewportAnchor = consumeZoomViewportAnchor?.() ?? null;
            const zoomAnchor = buildResizeAnchorContext({
                anchorViewportX: zoomViewportAnchor?.x ?? null,
                anchorViewportY: zoomViewportAnchor?.y ?? null,
            });
            BrowserLogger.warnThrottled('pdf-zoom-debug', 'zoom-watch-schedule-rerender', ZOOM_QUEUE_LOG_THROTTLE_MS, '[zoom-watch] schedule zoom rerender', {
                previousZoom,
                nextZoom,
                consumedZoomViewportAnchor: zoomViewportAnchor,
                builtZoomAnchor: zoomAnchor,
                viewer: summarizeViewerMetricsForLog(viewerContainer.value),
            });
            pendingZoomSyncOptions = {
                source: 'zoom-change',
                stabilize: true,
                resizeAnchor: zoomAnchor,
            };
            reportZoomBusyStateIfChanged('zoom-watch-enqueue');
            scheduleZoomRerender();
        }
    });

    watch(effectiveScale, (scale) => {
        annotationUiManager.value?.onScaleChanging({scale: scale / PixelsPerInch.PDF_TO_CSS_UNITS});
    });

    watch(currentPage, (page) => {
        annotationUiManager.value?.onPageChanging({ pageNumber: page });
    });

    watch(
        annotationTool,
        (tool) => {
            if (tool !== 'none') highlight.cancelCommentPlacement();
            scheduleSetAnnotationTool(tool, `apply annotation tool "${tool}"`);
        },
        { immediate: true },
    );

    watch(annotationCursorMode, () => {
        if (annotationTool.value === 'none') {
            scheduleSetAnnotationTool('none', 're-apply annotation cursor mode');
        }
    });

    const annotationSettingsSignature = computed(() => {
        const settings = annotationSettings.value;
        if (!settings) {
            return '';
        }
        return Object.values(settings).join('|');
    });
    watch(
        annotationSettingsSignature,
        () => {
            editor.applyAnnotationSettings(annotationSettings.value);
        },
        {immediate: true},
    );

    watch(isResizing, async (value) => {
        if (!value && pdfDocument.value && !isLoading.value) {
            await nextTick();
            await delay(20);
            computeFitWidthScale(viewerContainer.value);
            scheduleReRenderVisiblePages(
                're-render visible pages after resize settle',
                {
                    source: 'resize-settle',
                    stabilize: true,
                },
            );
        }
    });

    const isEffectivelyLoading = computed(() => !!src.value && isLoading.value);

    watch(
        isEffectivelyLoading,
        async (value, oldValue) => {
            if (oldValue === true && value === false) {
                await nextTick();
                scheduleRecoverInitialRender();
            }
            emit('update:loading', value);
            emit('loading', value);
        },
        { immediate: true },
    );

    return {
        shouldShowSkeleton,
        handleDragStart,
        handleDragMove,
        undoAnnotation,
        redoAnnotation,
        invalidatePages,
    };
};
