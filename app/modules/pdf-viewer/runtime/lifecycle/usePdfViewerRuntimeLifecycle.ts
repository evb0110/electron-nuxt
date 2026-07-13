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
    PDFDocumentProxy,
    PDFPageProxy,
    TFitMode,
    TPdfViewMode,
    TZoomMode,
} from '@app/types/pdfContracts';
import type {
    IPageRange,
    TPdfSource,
} from '@app/types/pdfUi';
import type { usePdfDocument } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfDocument';
import type { IFitScalePageOptions } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScale';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';
import type { TAnnotationOrchestrator } from '@app/modules/pdf-viewer/runtime/annotations/annotationOrchestrator';
import type { TPdfRerenderSource } from '@app/modules/pdf-viewer/engine/pdf-rerender-protocol/pdfRerenderProtocol';
import { runGuardedTask } from '@app/utils/asyncGuard';
import { usePdfViewerDocumentLifecycle } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerDocumentLifecycle';
import { usePdfViewerCurrentPageSync } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerCurrentPageSync';
import type { ICurrentPageSyncOptions } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerCurrentPageSync';
import { usePdfViewerResizeLifecycle } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerResizeLifecycle';
import { usePdfViewerRerenderCoordinator } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerRerenderCoordinator';
import { usePdfViewerRenderStallRecovery } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerRenderStallRecovery';
import { usePdfViewerZoomRerenderQueue } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerZoomRerenderQueue';
import type { usePdfViewerTransactionController } from '@app/modules/pdf-viewer/runtime/transactions/usePdfViewerTransactionController';
import { getPageRowBoundsForViewMode } from '@app/modules/pdf-viewer/engine/pdf-page-layout/getPageRowBoundsForViewMode';
import { usePdfViewerActivationRestore } from '@app/modules/pdf-viewer/runtime/lifecycle/usePdfViewerActivationRestore';
import { usePdfViewerAnnotationRuntimeBridge } from '@app/modules/pdf-viewer/runtime/annotations/usePdfViewerAnnotationRuntimeBridge';
import {
    resolvePdfViewerResidencyDecision,
    resolvePostReclaimResidencyState,
    type TViewerResidencyState,
} from '@app/modules/pdf-viewer/runtime/memory/resolvePdfViewerResidencyDecision';
import type {
    IResizeTransitionSignal,
    IZoomViewportAnchor,
} from '@app/modules/pdf-viewer/runtime/viewport/pdfViewerViewportTypes';
import type { TZoomInteractionLockOperationId } from '@app/modules/pdf-viewer/runtime/zoom/pdfViewerZoomTypes';
import type { IPdfViewportWritePort } from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportWritePort';
import type { IPdfSemanticAnchor } from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportGeometry';

type TPdfDocumentResult = ReturnType<typeof usePdfDocument>;
type TPdfViewerRuntimeTransactionController = ReturnType<typeof usePdfViewerTransactionController>;

interface IZoomRerenderBusySignal {
    operationId?: TZoomInteractionLockOperationId | null | undefined;
    reason: string;
}


export interface IUsePdfViewerRuntimeLifecycleOptions {
    viewportWritePort: IPdfViewportWritePort;
    submitResizeIntent: (anchor?: IPdfSemanticAnchor | null) => void;
    captureViewportAnchor?: (() => IPdfSemanticAnchor | null) | undefined;
    viewerContainer: Ref<HTMLElement | null>;
    src: ComputedRef<TPdfSource | null>;
    documentLifecycleKey?: ComputedRef<string | null> | undefined;
    reloadSrc?: ComputedRef<TPdfSource | null> | undefined;
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
    clearAnnotationProjection?: (() => void) | undefined;
    activeCommentStableKey: Ref<string | null>;
    pdfDocumentResult: TPdfDocumentResult;
    annotations: TAnnotationOrchestrator;
    currentPage: Ref<number>;
    currentPageAuthority?: {
        canSyncFromViewport: (source: string) => boolean;
        commitViewportPage: (
            page: number,
            context: {
                previousPage: number;
                source: string;
            },
        ) => boolean;
    } | undefined;
    pagedNavigationTargetPage?: Readonly<Ref<number | null>> | undefined;
    navigationAnchorPage?: Readonly<Ref<number | null>> | undefined;
    visibleRange: Ref<{
        start: number;
        end: number;
    }>;
    commitVisibleRange?: ((range: IPageRange) => boolean | undefined) | undefined;
    effectiveScale: Ref<number>;
    basePageWidth: Ref<number | null>;
    basePageHeight: Ref<number | null>;
    computeFitWidthScale: (container: HTMLElement | null, options?: IFitScalePageOptions) => boolean;
    clearPreviewFitScale?: (() => void) | undefined;
    syncHorizontalScrollForZoomMode?: () => boolean;
    invalidateScaleCache: () => void;
    resetScale: () => void;
    seedOpeningFitScale?: (() => boolean) | undefined;
    computeSkeletonInsets: (
        pdfPage: PDFPageProxy,
        renderVersion: number,
        getCurrentVersion: () => number,
    ) => Promise<void>;
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
            rerenderSource?: TPdfRerenderSource;
            renderBufferOverride?: number | undefined;
        },
    ) => Promise<void>;
    cancelInFlightPageRenders?: (() => Promise<void> | void) | undefined;
    cancelPendingSearchScroll?: (() => void) | undefined;
    cleanupRenderedPages: () => void;
    invalidateRenderedPages: (pages: number[]) => void;
    shouldPreserveOpeningLayout?: (() => boolean) | undefined;
    applySearchHighlights: () => void;
    isPageRendered: (page: number) => boolean;
    getMostVisiblePage: (
        container: HTMLElement | null,
        numPages: number,
    ) => number;
    getVisiblePageRange?: ((container: HTMLElement | null, numPages: number) => IPageRange) | undefined;
    updateCurrentPage: (
        container: HTMLElement | null,
        numPages: number,
        options?: { requireAuthoritative?: boolean; },
    ) => number;
    updateVisibleRange: (container: HTMLElement | null, numPages: number) => void;
    scrollToPage: (pageNumber: number, options?: IScrollToPageOptions) => void;
    commitReloadViewport?: ((pageNumber: number, options?: IScrollToPageOptions) => void) | undefined;
    resetContinuousScrollState: () => void;
    cancelDestinationNavigationTarget?: (() => void) | undefined;
    getUserViewportInteractionEpoch?: (() => number) | undefined;
    cancelInitialVisualReady?: (() => void) | undefined;
    startDrag: (e: MouseEvent, container: HTMLElement | null) => void;
    onDrag: (e: MouseEvent, container: HTMLElement | null) => void;
    stopDrag: () => void;
    consumeZoomViewportAnchor?: (() => IZoomViewportAnchor | null) | undefined;
    isZoomInteractionLocked?: (() => boolean) | undefined;
    isZoomGestureSessionLocked?: (() => boolean) | undefined;
    setZoomRerenderBusy?: ((
        busy: boolean,
        signal?: IZoomRerenderBusySignal,
    ) => TZoomInteractionLockOperationId | null | undefined) | undefined;
    setResizeTransitionVisible?: ((payload: IResizeTransitionSignal) => void) | undefined;
    onDocumentLoadStateChange?: ((payload: {
        token: number;
        phase: 'started' | 'settled';
    }) => void) | undefined;
    waitForInitialCanvasCommit?: ((pageNumber: number) => Promise<void>) | undefined;
    isInitialCanvasCommitted?: (() => boolean) | undefined;
    isInitialVisualCommitted?: (() => boolean) | undefined;
    pinCurrentPageDuringRecovery: (
        page: number,
        options?: {
            durationMs?: number;
            reason?: string;
        },
    ) => void;
    beginVisualReloadTransition: (reason: string) => number;
    endVisualReloadTransition: (token: number, reason: string) => void;
    transactionController?: TPdfViewerRuntimeTransactionController | undefined;
    emitLoadError?: ((error: unknown) => void) | undefined;
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
        documentLifecycleKey,
        reloadSrc,
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
        clearAnnotationProjection,
        activeCommentStableKey,
        pdfDocumentResult,
        annotations,
        currentPage,
        currentPageAuthority,
        visibleRange,
        effectiveScale,
        basePageWidth,
        basePageHeight,
        computeFitWidthScale,
        clearPreviewFitScale,
        captureViewportAnchor,
        syncHorizontalScrollForZoomMode,
        invalidateScaleCache,
        resetScale,
        computeSkeletonInsets,
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
        getVisiblePageRange,
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
        transactionController,
        emitLoadError,
        emit,
    } = options;
    const isActive = computed(() => isActiveOption?.value ?? true);
    let viewerResidencyState: TViewerResidencyState = isActive.value ? 'active' : 'warm';

    const {
        pdfDocument,
        numPages,
        isLoading,
        loadError,
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
        canSyncCurrentPageFromViewport: currentPageAuthority
            ? source => currentPageAuthority.canSyncFromViewport(source)
            : undefined,
        commitCurrentPageFromViewport: currentPageAuthority
            ? (page, context) => currentPageAuthority.commitViewportPage(page, {
                previousPage: context.previousPage,
                source: context.source,
            })
            : undefined,
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
        transactionController,
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
            return {
                start: rowBounds.start,
                end: rowBounds.end,
            };
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
        getVisiblePageRange,
        updateVisibleRange,
        scrollToPage,
        renderVisiblePages,
        isPageRendered,
        applySearchHighlights,
        transactionController,
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
        const document = pdfDocument.value;
        const decision = resolvePdfViewerResidencyDecision({
            isActive: false,
            isAnySaving: options.isAnySaving?.value === true,
            hasReclaimableDocumentCaches: Boolean(document && typeof document.cleanup === 'function'),
            previousState: viewerResidencyState,
        });
        viewerResidencyState = decision.state;

        if (!decision.shouldCleanupDocumentCaches) {
            return;
        }
        if (!document || typeof document.cleanup !== 'function') {
            return;
        }
        void document.cleanup()
            .then(() => {
                if (!isActive.value) {
                    viewerResidencyState = resolvePostReclaimResidencyState(viewerResidencyState);
                }
            })
            .catch(() => {});
    }

    const {
        buildResizeAnchorContext,
        beginResizeTransition,
        scheduleEndResizeTransition,
        cleanupResizeLifecycle,
    } = usePdfViewerResizeLifecycle({
        submitResizeIntent: options.submitResizeIntent,
        viewerContainer,
        isLoading,
        isActive,
        isResizing,
        pdfDocument,
        currentPage,
        pendingNavigationAnchorPage: options.navigationAnchorPage ?? options.pagedNavigationTargetPage,
        visibleRange,
        numPages,
        computeFitWidthScale,
        clearPreviewFitScale,
        captureViewportAnchor,
        getMostVisiblePage,
        summarizeViewerMetricsForLog,
        summarizeVisiblePageSnapshotForLog,
        scheduleResizeAwareRerender: (stage, syncOptions) => scheduleResizeAwareRerender(stage, syncOptions),
        setResizeTransitionVisible,
        transactionController,
    });

    const {
        invalidateDocumentLoad,
        preserveNextSourceReloadVisibleContent,
        scheduleLoadFromSource,
    } = usePdfViewerDocumentLifecycle({
        viewerContainer,
        src,
        documentLifecycleKey,
        reloadSrc,
        zoom,
        zoomMode,
        effectiveScale,
        currentPage,
        visibleRange,
        basePageWidth,
        basePageHeight,
        annotationUiManager,
        annotationCommentsCache,
        clearAnnotationProjection,
        activeCommentStableKey,
        pdfDocument,
        numPages,
        isLoading,
        loadError,
        getRenderVersion,
        loadPdf,
        ensurePageMetricsInRange,
        getPage,
        renderVisiblePages: (range, options) => renderVisiblePages(range, options),
        getVisibleRange,
        reRenderVisiblePagesAndSyncCurrentPage: (syncOptions) => rerenderVisiblePagesAndSyncCurrentPage(syncOptions),
        syncCurrentPageFromViewport: (options) => syncCurrentPageFromViewport(options),
        getUserViewportInteractionEpoch,
        applySearchHighlights,
        getVisiblePageRange,
        updateVisibleRange,
        scrollToPage,
        commitReloadViewport: options.commitReloadViewport,
        cleanupRenderedPages,
        invalidateScaleCache,
        shouldPreserveOpeningLayout: options.shouldPreserveOpeningLayout,
        resetScale,
        seedOpeningFitScale: options.seedOpeningFitScale,
        resetInsets,
        setupPagePlaceholders,
        computeFitWidthScale,
        computeSkeletonInsets,
        invalidateRenderedPages,
        consumePendingInvalidation,
        commentSync,
        editor,
        pinCurrentPageDuringRecovery,
        suppressNextZoomRerender,
        beginVisualReloadTransition,
        endVisualReloadTransition,
        transactionController,
        emitLoadError,
        onDocumentLoadStateChange: options.onDocumentLoadStateChange,
        waitForInitialCanvasCommit: options.waitForInitialCanvasCommit,
        isInitialCanvasCommitted: options.isInitialCanvasCommitted,
        isInitialVisualCommitted: options.isInitialVisualCommitted,
        emit,
    });
    const zoomRerenderQueue = usePdfViewerZoomRerenderQueue({
        pdfDocument,
        isLoading,
        viewerContainer,
        summarizeViewerMetricsForLog,
        reRenderVisiblePagesAndSyncCurrentPage: (syncOptions) => rerenderVisiblePagesAndSyncCurrentPage(syncOptions),
        buildResizeAnchorContext: () => buildResizeAnchorContext(),
        scheduleEndResizeTransition,
        isZoomInteractionLocked,
        isZoomGestureSessionLocked,
        setZoomRerenderBusy,
        transactionController,
    });
    resetZoomRerenderQueueState = zoomRerenderQueue.resetZoomRerenderQueueState;
    scheduleResizeAwareRerender = zoomRerenderQueue.scheduleResizeAwareRerender;
    enqueueZoomSync = zoomRerenderQueue.enqueueZoomSync;
    const { cleanupZoomRerenderQueue } = zoomRerenderQueue;
    const {reRenderVisiblePagesAndSyncCurrentPage: reRenderVisiblePagesAndSyncCurrentPageFromCoordinator} = usePdfViewerRerenderCoordinator({
        viewerContainer,
        pdfDocument,
        isLoading,
        numPages,
        currentPage,
        pagedNavigationTargetPage: options.pagedNavigationTargetPage,
        navigationAnchorPage: options.navigationAnchorPage,
        visibleRange,
        commitVisibleRange: options.commitVisibleRange,
        zoom,
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
        transactionController,
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
            viewerResidencyState = 'active';
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
                    category: 'user-visible-operation',
                    scope: 'pdf-viewer',
                    message: 'Failed to restore PDF rendering after tab activation',
                });
            }
            return;
        }
        invalidateDocumentLoad();
        options.cancelInitialVisualReady?.();
        cancelPendingSearchScroll?.();
        void cancelInFlightPageRenders?.();
        cleanupRenderedPages();
        cleanupInactiveDocumentCaches();
        resetZoomRerenderQueueState('inactive-tab');
        cleanupResizeLifecycle();
        highlight.clearSelectionCache();
    });

    onUnmounted(() => {
        resetRenderStallRecoveryState();
        options.cancelInitialVisualReady?.();
        cleanupZoomRerenderQueue();
        cleanupResizeLifecycle();
        inlineIndicators.cleanup();
        highlight.clearSelectionCache();
        cleanupRenderedPages();
        editor.destroyAnnotationEditor();
        cleanupDocument();
        options.clearAnnotationProjection?.();
        activeCommentStableKey.value = null;
        emit('annotation-comments', []);
    });

    watch(src, (newSrc, oldSrc) => {
        if (newSrc !== oldSrc) {
            nextActivationRestoreRunId();
            resetRenderStallRecoveryState();
            resetZoomRerenderQueueState('source-change');
            options.cancelInitialVisualReady?.();
            // An initial source can arrive after the chassis has already
            // accepted navigation for that opening session. Only replacement
            // or close invalidates an existing document destination; clearing
            // on first assignment races and drops the new session's request.
            if (oldSrc) {
                cancelDestinationNavigationTarget?.();
            }
            const isReload = !!oldSrc && !!newSrc;
            if (!newSrc) {
                invalidateDocumentLoad();
                cancelPendingSearchScroll?.();
                void cancelInFlightPageRenders?.();
                cleanupRenderedPages();
                editor.destroyAnnotationEditor();
                cleanupDocument();
                emit('update:document', null);
                options.clearAnnotationProjection?.();
                activeCommentStableKey.value = null;
                emit('annotation-comments', []);
                return;
            }
            if (!isActive.value) {
                invalidateDocumentLoad();
                cancelPendingSearchScroll?.();
                void cancelInFlightPageRenders?.();
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
        (value) => {
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
