import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type {
    IAnnotationCommentSummary,
    IAnnotationSettings,
    TAnnotationTool,
} from '@app/types/annotations';
import type {
    IPageRange,
    IScrollSnapshot,
    PDFDocumentProxy,
    PDFPageProxy,
    TFitMode,
    TPdfSource,
    TPdfViewMode,
    TZoomMode,
} from '@app/types/pdf';
import type { usePdfDocument } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfDocument';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';
import type { TAnnotationOrchestrator } from '@app/modules/pdf-viewer/runtime/annotations/annotationOrchestrator';
import { runGuardedTask } from '@app/utils/asyncGuard';
import { usePdfViewerDocumentLifecycle } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerDocumentLifecycle';
import { usePdfViewerCurrentPageSync } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerCurrentPageSync';
import type { ICurrentPageSyncOptions } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerCurrentPageSync';
import { usePdfViewerResizeLifecycle } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerResizeLifecycle';
import { usePdfViewerRerenderCoordinator } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerRerenderCoordinator';
import { usePdfViewerRenderStallRecovery } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerRenderStallRecovery';
import { usePdfViewerZoomRerenderQueue } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerZoomRerenderQueue';
import { getPageRowBoundsForViewMode } from '@app/modules/pdf-viewer/engine/pdf-page-layout/getPageRowBoundsForViewMode';
import { usePdfViewerActivationRestore } from '@app/modules/pdf-viewer/runtime/lifecycle/usePdfViewerActivationRestore';
import { usePdfViewerAnnotationRuntimeBridge } from '@app/modules/pdf-viewer/runtime/annotations/usePdfViewerAnnotationRuntimeBridge';
import type {
    IResizeTransitionSignal,
    IZoomViewportAnchor,
} from '@app/modules/pdf-viewer/runtime/viewport/pdfViewerViewportTypes';

type TPdfDocumentResult = ReturnType<typeof usePdfDocument>;


export interface IUsePdfViewerRuntimeLifecycleOptions {
    viewerContainer: Ref<HTMLElement | null>;
    src: ComputedRef<TPdfSource | null>;
    isAnySaving?: ComputedRef<boolean> | undefined;
    zoom: ComputedRef<number>;
    zoomMode: ComputedRef<TZoomMode>;
    fitMode: ComputedRef<TFitMode>;
    viewMode: ComputedRef<TPdfViewMode>;
    isActive?: ComputedRef<boolean> | undefined;
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
    pagedNavigationTargetPage?: Readonly<Ref<number | null>> | undefined;
    visibleRange: Ref<{
        start: number;
        end: number;
    }>;
    effectiveScale: Ref<number>;
    basePageWidth: Ref<number | null>;
    basePageHeight: Ref<number | null>;
    computeFitWidthScale: (container: HTMLElement | null) => boolean;
    syncHorizontalScrollForZoomMode?: () => boolean;
    invalidateScaleCache: () => void;
    resetScale: () => void;
    computeSkeletonInsets: (
        pdfPage: PDFPageProxy,
        renderVersion: number,
        getCurrentVersion: () => number,
    ) => Promise<void>;
    beforeInitialRender?: () => Promise<void>;
    resetInsets: () => void;
    setupPagePlaceholders: () => void;
    renderVisiblePages: (
        range: IPageRange,
        options?: {
            preserveRenderedPages?: boolean;
            bufferOverride?: number;
            forceRerender?: boolean;
        },
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
            renderBufferOverride?: number | undefined;
            maxCanvasPixelsOverride?: number | undefined;
        },
    ) => Promise<void>;
    cancelInFlightPageRenders?: (() => void) | undefined;
    cancelPendingSearchScroll?: (() => void) | undefined;
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
        options?: { requireAuthoritative?: boolean; },
    ) => number;
    updateVisibleRange: (container: HTMLElement | null, numPages: number) => void;
    scrollToPage: (pageNumber: number, options?: IScrollToPageOptions) => void;
    resetContinuousScrollState: () => void;
    cancelDestinationNavigationTarget?: (() => void) | undefined;
    getUserViewportInteractionEpoch?: (() => number) | undefined;
    startDrag: (e: MouseEvent, container: HTMLElement | null) => void;
    onDrag: (e: MouseEvent, container: HTMLElement | null) => void;
    stopDrag: () => void;
    consumeZoomViewportAnchor?: (() => IZoomViewportAnchor | null) | undefined;
    isZoomInteractionLocked?: (() => boolean) | undefined;
    isZoomGestureSessionLocked?: (() => boolean) | undefined;
    setZoomRerenderBusy?: ((busy: boolean) => void) | undefined;
    setResizeTransitionVisible?: ((payload: IResizeTransitionSignal) => void) | undefined;
    onDocumentLoadStateChange?: ((payload: {
        token: number;
        phase: 'started' | 'settled';
    }) => void) | undefined;
    pinCurrentPageDuringRecovery: (
        page: number,
        options?: {
            durationMs?: number;
            reason?: string;
        },
    ) => void;
    beginVisualReloadTransition: (reason: string) => number;
    endVisualReloadTransition: (token: number, reason: string) => void;
    setCurrentPageFitRerenderTransitionActive?: ((active: boolean) => void) | undefined;
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

export const usePdfViewerRuntimeLifecycle = (options: IUsePdfViewerRuntimeLifecycleOptions) => {
    const {
        viewerContainer,
        src,
        zoom,
        zoomMode,
        fitMode,
        viewMode,
        isActive: isActiveOption,
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
        syncHorizontalScrollForZoomMode,
        invalidateScaleCache,
        resetScale,
        computeSkeletonInsets,
        beforeInitialRender,
        resetInsets,
        setupPagePlaceholders,
        renderVisiblePages,
        reRenderAllVisiblePages,
        cancelInFlightPageRenders,
        cancelPendingSearchScroll,
        cleanupRenderedPages,
        invalidateRenderedPages,
        applySearchHighlights,
        isPageRendered,
        getMostVisiblePage,
        updateCurrentPage,
        updateVisibleRange,
        scrollToPage,
        resetContinuousScrollState,
        cancelDestinationNavigationTarget,
        getUserViewportInteractionEpoch,
        startDrag,
        onDrag,
        consumeZoomViewportAnchor,
        isZoomInteractionLocked,
        isZoomGestureSessionLocked,
        setZoomRerenderBusy,
        setResizeTransitionVisible,
        pinCurrentPageDuringRecovery,
        beginVisualReloadTransition,
        endVisualReloadTransition,
        setCurrentPageFitRerenderTransitionActive,
        emit,
    } = options;
    const isActive = computed(() => isActiveOption?.value ?? true);

    const {
        pdfDocument,
        numPages,
        isLoading,
        getRenderVersion,
        loadPdf,
        ensurePageMetricsInRange,
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
    const {
        summarizeViewerMetricsForLog,
        summarizeVisiblePageSnapshotForLog,
        syncCurrentPageFromViewport,
    } = usePdfViewerCurrentPageSync({
        viewerContainer,
        numPages,
        visibleRange,
        currentPage,
        pdfDocument,
        isLoading,
        getMostVisiblePage,
        updateCurrentPage,
        emitCurrentPage: (page) => {
            emit('update:currentPage', page);
        },
    });
    const {
        resetRenderStallRecoveryState,
        invalidatePages,
        consumePendingInvalidation,
        handlePageRenderStall,
    } = usePdfViewerRenderStallRecovery({
        src,
        isLoading,
        isAnySaving: options.isAnySaving,
        numPages,
        currentPage,
        visibleRange,
        viewerContainer,
        summarizeViewerMetricsForLog,
        cancelInFlightPageRenders,
        renderVisiblePages,
        scheduleReload: (isReload = false) => {
            scheduleLoadFromSource(isReload);
        },
    });

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
        if (!continuousScroll.value && numPages.value > 0) {
            const rowBounds = getPageRowBoundsForViewMode({
                pageNumber: currentPage.value,
                viewMode: viewMode.value,
                totalPages: numPages.value,
            });
            visibleRange.value = {
                start: rowBounds.start,
                end: rowBounds.end,
            };
            return visibleRange.value;
        }
        updateVisibleRange(viewerContainer.value, numPages.value);
        return visibleRange.value;
    }

    const {
        nextActivationRestoreRunId,
        isActivationRunCurrent,
        renderActiveDocumentAfterActivation,
    } = usePdfViewerActivationRestore({
        viewerContainer,
        pdfDocument,
        isActive,
        isLoading,
        numPages,
        currentPage,
        visibleRange,
        viewMode,
        updateVisibleRange,
        scrollToPage,
        renderVisiblePages,
        isPageRendered,
        applySearchHighlights,
    });

    let rerenderVisiblePagesAndSyncCurrentPage: (
        syncOptions?: ICurrentPageSyncOptions,
    ) => Promise<void> = async () => {};
    let scheduleResizeAwareRerender: (
        stage: string,
        syncOptions?: ICurrentPageSyncOptions,
    ) => void = () => {};
    let resetZoomRerenderQueueState: (reason: string) => void = () => {};
    let enqueueZoomSync: (syncOptions: ICurrentPageSyncOptions) => void = () => {};
    let markLowResZoomRerenderUsed: () => void = () => {};
    let suppressedZoomRerenderTarget: number | null = null;

    function suppressNextZoomRerender(targetZoom: number) {
        suppressedZoomRerenderTarget = targetZoom;
    }

    function consumeSuppressedZoomRerender(nextZoom: number) {
        if (
            suppressedZoomRerenderTarget === null
            || Math.abs(nextZoom - suppressedZoomRerenderTarget) > 0.001
        ) {
            return false;
        }

        suppressedZoomRerenderTarget = null;
        return true;
    }

    function cleanupInactiveDocumentCaches() {
        if (options.isAnySaving?.value) {
            return;
        }
        const document = pdfDocument.value;
        if (!document || typeof document.cleanup !== 'function') {
            return;
        }
        void document.cleanup().catch(() => {});
    }

    const {
        buildResizeAnchorContext,
        beginResizeTransition,
        scheduleEndResizeTransition,
        cleanupResizeLifecycle,
    } = usePdfViewerResizeLifecycle({
        viewerContainer,
        isLoading,
        isActive,
        isResizing,
        pdfDocument,
        currentPage,
        visibleRange,
        numPages,
        computeFitWidthScale,
        getMostVisiblePage,
        summarizeViewerMetricsForLog,
        summarizeVisiblePageSnapshotForLog,
        scheduleResizeAwareRerender: (stage, syncOptions) => scheduleResizeAwareRerender(stage, syncOptions),
        setResizeTransitionVisible,
    });

    const {
        isLoadFromSourceActive,
        invalidateDocumentLoad,
        preserveNextSourceReloadVisibleContent,
        scheduleRecoverInitialRender,
        scheduleLoadFromSource,
    } = usePdfViewerDocumentLifecycle({
        viewerContainer,
        src,
        zoom,
        zoomMode,
        effectiveScale,
        currentPage,
        visibleRange,
        basePageWidth,
        basePageHeight,
        annotationUiManager,
        annotationCommentsCache,
        activeCommentStableKey,
        pdfDocument,
        numPages,
        isLoading,
        getRenderVersion,
        loadPdf,
        ensurePageMetricsInRange,
        getPage,
        renderVisiblePages: (range, options) => renderVisiblePages(range, options),
        getVisibleRange,
        reRenderVisiblePagesAndSyncCurrentPage: () => rerenderVisiblePagesAndSyncCurrentPage(),
        syncCurrentPageFromViewport: (options) => syncCurrentPageFromViewport(options),
        applySearchHighlights,
        updateVisibleRange,
        scrollToPage,
        cleanupRenderedPages,
        invalidateScaleCache,
        resetScale,
        resetInsets,
        setupPagePlaceholders,
        computeFitWidthScale,
        computeSkeletonInsets,
        beforeInitialRender,
        invalidateRenderedPages,
        consumePendingInvalidation,
        commentSync,
        editor,
        pinCurrentPageDuringRecovery,
        suppressNextZoomRerender,
        beginVisualReloadTransition,
        endVisualReloadTransition,
        onDocumentLoadStateChange: options.onDocumentLoadStateChange,
        emit,
    });
    const zoomRerenderQueue = usePdfViewerZoomRerenderQueue({
        pdfDocument,
        isLoading,
        viewerContainer,
        summarizeViewerMetricsForLog,
        reRenderVisiblePagesAndSyncCurrentPage: (syncOptions) => rerenderVisiblePagesAndSyncCurrentPage(syncOptions),
        buildResizeAnchorContext: () => buildResizeAnchorContext(),
        isZoomInteractionLocked,
        isZoomGestureSessionLocked,
        setZoomRerenderBusy,
    });
    resetZoomRerenderQueueState = zoomRerenderQueue.resetZoomRerenderQueueState;
    scheduleResizeAwareRerender = zoomRerenderQueue.scheduleResizeAwareRerender;
    enqueueZoomSync = zoomRerenderQueue.enqueueZoomSync;
    markLowResZoomRerenderUsed = zoomRerenderQueue.markLowResZoomRerenderUsed;
    const { cleanupZoomRerenderQueue } = zoomRerenderQueue;
    const {reRenderVisiblePagesAndSyncCurrentPage: reRenderVisiblePagesAndSyncCurrentPageFromCoordinator} = usePdfViewerRerenderCoordinator({
        viewerContainer,
        pdfDocument,
        isLoading,
        numPages,
        currentPage,
        pagedNavigationTargetPage: options.pagedNavigationTargetPage,
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
        markLowResZoomRerenderUsed: () => markLowResZoomRerenderUsed(),
        buildResizeAnchorContext,
        scheduleEndResizeTransition,
        enqueueZoomSync: (syncOptions) => enqueueZoomSync(syncOptions),
        scheduleResizeAwareRerender: (stage, syncOptions) => scheduleResizeAwareRerender(stage, syncOptions),
        cancelInFlightPageRenders,
        ensurePageMetricsInRange,
        computeFitWidthScale,
        zoomMode,
        syncHorizontalScrollForZoomMode,
        setupPagePlaceholders,
        scrollToPage,
        getMostVisiblePage,
        resetContinuousScrollState,
        cancelDestinationNavigationTarget,
        resetZoomRerenderQueueState: (reason) => resetZoomRerenderQueueState(reason),
        getUserViewportInteractionEpoch,
        consumeZoomViewportAnchor,
        beginResizeTransition,
        consumeSuppressedZoomRerender,
        setCurrentPageFitRerenderTransitionActive,
    });
    rerenderVisiblePagesAndSyncCurrentPage = reRenderVisiblePagesAndSyncCurrentPageFromCoordinator;

    const { scheduleSetAnnotationTool } = usePdfViewerAnnotationRuntimeBridge({
        viewerContainer: options.viewerContainer,
        isActive,
        currentPage,
        effectiveScale,
        annotationTool,
        annotationCursorMode,
        annotationSettings,
        annotationUiManager,
        annotationCommentsCache,
        activeCommentStableKey,
        annotations,
    });

    function undoAnnotation() {
        annotationUiManager.value?.undo();
    }
    function redoAnnotation() {
        annotationUiManager.value?.redo();
    }

    onMounted(() => {
        inlineIndicators.attachInlineCommentMarkerObserver();
        if (isActive.value) {
            scheduleLoadFromSource();
        }
    });

    watch(isActive, async (active) => {
        const runId = nextActivationRestoreRunId();
        if (active) {
            await nextTick();
            if (!isActivationRunCurrent(runId)) {
                return;
            }
            scheduleSetAnnotationTool(annotationTool.value, 'restore annotation tool after tab activation');
            editor.applyAnnotationSettings(annotationSettings.value);
            if (src.value && !pdfDocument.value && !isLoading.value) {
                scheduleLoadFromSource();
                return;
            }
            if (pdfDocument.value && !isLoading.value) {
                runGuardedTask(() => renderActiveDocumentAfterActivation(runId), {
                    scope: 'pdf-viewer',
                    message: 'Failed to restore PDF rendering after tab activation',
                });
            }
            return;
        }
        cancelPendingSearchScroll?.();
        cancelInFlightPageRenders?.();
        cleanupRenderedPages();
        cleanupInactiveDocumentCaches();
        resetZoomRerenderQueueState('inactive-tab');
        cleanupResizeLifecycle();
        highlight.clearSelectionCache();
    });

    onUnmounted(() => {
        resetRenderStallRecoveryState();
        cleanupZoomRerenderQueue();
        cleanupResizeLifecycle();
        inlineIndicators.cleanup();
        highlight.clearSelectionCache();
        cleanupRenderedPages();
        editor.destroyAnnotationEditor();
        cleanupDocument();
        annotationCommentsCache.value = [];
        activeCommentStableKey.value = null;
        emit('annotation-comments', []);
    });

    watch(src, (newSrc, oldSrc) => {
        if (newSrc !== oldSrc) {
            nextActivationRestoreRunId();
            resetRenderStallRecoveryState();
            cancelDestinationNavigationTarget?.();
            const isReload = !!oldSrc && !!newSrc;
            if (!newSrc) {
                invalidateDocumentLoad();
                cancelPendingSearchScroll?.();
                cancelInFlightPageRenders?.();
                cleanupRenderedPages();
                editor.destroyAnnotationEditor();
                cleanupDocument();
                emit('update:document', null);
                annotationCommentsCache.value = [];
                activeCommentStableKey.value = null;
                emit('annotation-comments', []);
                return;
            }
            if (!isActive.value) {
                invalidateDocumentLoad();
                cancelPendingSearchScroll?.();
                cancelInFlightPageRenders?.();
                cleanupRenderedPages();
                cleanupDocument();
                emit('update:document', null);
                return;
            }
            scheduleLoadFromSource(isReload);
        }
    });

    const isEffectivelyLoading = computed(() => !!src.value && isLoading.value);

    watch(
        isEffectivelyLoading,
        async (value, oldValue) => {
            if (oldValue === true && value === false) {
                if (!isLoadFromSourceActive.value) {
                    await nextTick();
                    scheduleRecoverInitialRender();
                }
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
        handlePageRenderStall,
        preserveNextSourceReloadVisibleContent,
    };
};
