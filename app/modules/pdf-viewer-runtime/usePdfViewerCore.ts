import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import {useEventListener} from '@vueuse/core';
import { PixelsPerInch } from '@app/services/pdfjs/runtimeLib';
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
    TPdfSource,
    IScrollSnapshot,
    TZoomMode,
} from '@app/types/pdf';
import type { usePdfDocument } from '@app/composables/pdf/usePdfDocument';
import type { useAnnotationOrchestrator } from '@app/composables/pdf/annotations/useAnnotationOrchestrator';
import { runGuardedTask } from '@app/utils/asyncGuard';
import { usePdfViewerDocumentLifecycle } from '@app/modules/pdf-viewer-runtime/composables/usePdfViewerDocumentLifecycle';
import {
    type ICurrentPageSyncOptions,
    usePdfViewerCurrentPageSync,
} from '@app/modules/pdf-viewer-runtime/composables/usePdfViewerCurrentPageSync';
import { usePdfViewerResizeLifecycle } from '@app/modules/pdf-viewer-runtime/composables/usePdfViewerResizeLifecycle';
import { usePdfViewerRerenderCoordinator } from '@app/modules/pdf-viewer-runtime/composables/usePdfViewerRerenderCoordinator';
import { usePdfViewerRenderStallRecovery } from '@app/modules/pdf-viewer-runtime/composables/usePdfViewerRenderStallRecovery';
import { usePdfViewerZoomRerenderQueue } from '@app/modules/pdf-viewer-runtime/composables/usePdfViewerZoomRerenderQueue';

type TPdfDocumentResult = ReturnType<typeof usePdfDocument>;
type TAnnotationOrchestrator = ReturnType<typeof useAnnotationOrchestrator>;

interface IPageRange {
    start: number;
    end: number;
}

interface IUsePdfViewerCoreOptions {
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
    scrollToPage: (pageNumber: number, options?: { preferExactDom?: boolean; }) => void;
    resetContinuousScrollState: () => void;
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

interface IZoomViewportAnchor {
    id?: number;
    sessionId?: number;
    x: number;
    y: number;
    capturedAtMs: number;
}

function createRequiredDelegate<TArgs extends unknown[], TResult>(
    label: string,
) {
    let implementation: ((...args: TArgs) => TResult) | null = null;

    return {
        bind(fn: (...args: TArgs) => TResult) {
            implementation = fn;
        },
        call(...args: TArgs): TResult {
            if (!implementation) {
                throw new Error(`${label} delegate was used before initialization`);
            }
            return implementation(...args);
        },
    };
}

function createRequiredVoidDelegate<TArgs extends unknown[]>(label: string) {
    let implementation: ((...args: TArgs) => void) | null = null;

    return {
        bind(fn: (...args: TArgs) => void) {
            implementation = fn;
        },
        call(...args: TArgs) {
            if (!implementation) {
                throw new Error(`${label} delegate was used before initialization`);
            }
            implementation(...args);
        },
    };
}

export const usePdfViewerCore = (options: IUsePdfViewerCoreOptions) => {
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
        updateVisibleRange(viewerContainer.value, numPages.value);
        return visibleRange.value;
    }

    const rerenderSyncDelegate = createRequiredDelegate<
        [syncOptions?: ICurrentPageSyncOptions],
        Promise<void>
    >('pdf-viewer-rerender-sync');
    const scheduleResizeAwareRerenderDelegate = createRequiredVoidDelegate<
        [stage: string, syncOptions?: ICurrentPageSyncOptions]
    >('pdf-viewer-resize-aware-rerender');
    const resetZoomRerenderQueueStateDelegate = createRequiredVoidDelegate<
        [reason: string]
    >('pdf-viewer-reset-zoom-rerender-queue');
    const enqueueZoomSyncDelegate = createRequiredVoidDelegate<
        [syncOptions: ICurrentPageSyncOptions]
    >('pdf-viewer-enqueue-zoom-sync');
    const markLowResZoomRerenderUsedDelegate = createRequiredVoidDelegate<
        []
    >('pdf-viewer-mark-low-res-zoom-rerender-used');
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
        scheduleResizeAwareRerender: (stage, syncOptions) => scheduleResizeAwareRerenderDelegate.call(stage, syncOptions),
        setResizeTransitionVisible,
    });

    const {
        isLoadFromSourceActive,
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
        reRenderVisiblePagesAndSyncCurrentPage: () => rerenderSyncDelegate.call(),
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
    const {
        resetZoomRerenderQueueState,
        scheduleResizeAwareRerender,
        enqueueZoomSync,
        markLowResZoomRerenderUsed,
        cleanupZoomRerenderQueue,
    } = usePdfViewerZoomRerenderQueue({
        pdfDocument,
        isLoading,
        viewerContainer,
        summarizeViewerMetricsForLog,
        reRenderVisiblePagesAndSyncCurrentPage: (syncOptions) => rerenderSyncDelegate.call(syncOptions),
        buildResizeAnchorContext: () => buildResizeAnchorContext(),
        isZoomInteractionLocked,
        isZoomGestureSessionLocked,
        setZoomRerenderBusy,
    });
    resetZoomRerenderQueueStateDelegate.bind(resetZoomRerenderQueueState);
    scheduleResizeAwareRerenderDelegate.bind(scheduleResizeAwareRerender);
    enqueueZoomSyncDelegate.bind(enqueueZoomSync);
    markLowResZoomRerenderUsedDelegate.bind(markLowResZoomRerenderUsed);
    const {reRenderVisiblePagesAndSyncCurrentPage: reRenderVisiblePagesAndSyncCurrentPageFromCoordinator} = usePdfViewerRerenderCoordinator({
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
        markLowResZoomRerenderUsed: () => markLowResZoomRerenderUsedDelegate.call(),
        buildResizeAnchorContext,
        scheduleEndResizeTransition,
        enqueueZoomSync: (syncOptions) => enqueueZoomSyncDelegate.call(syncOptions),
        scheduleResizeAwareRerender: (stage, syncOptions) => scheduleResizeAwareRerenderDelegate.call(stage, syncOptions),
        cancelInFlightPageRenders,
        computeFitWidthScale,
        zoomMode,
        syncHorizontalScrollForZoomMode,
        setupPagePlaceholders,
        scrollToPage,
        getMostVisiblePage,
        resetContinuousScrollState,
        resetZoomRerenderQueueState: (reason) => resetZoomRerenderQueueStateDelegate.call(reason),
        consumeZoomViewportAnchor,
        beginResizeTransition,
        consumeSuppressedZoomRerender,
    });
    rerenderSyncDelegate.bind(reRenderVisiblePagesAndSyncCurrentPageFromCoordinator);

    function scheduleSetAnnotationTool(tool: TAnnotationTool, stage: string) {
        runGuardedTask(() => editor.setAnnotationTool(tool), {
            scope: 'pdf-viewer',
            message: `Failed to ${stage}`,
        });
    }

    function undoAnnotation() {
        annotationUiManager.value?.undo();
    }
    function redoAnnotation() {
        annotationUiManager.value?.redo();
    }

    const documentTarget = typeof document !== 'undefined' ? document : null;
    useEventListener(
        documentTarget,
        'selectionchange',
        () => {
            if (isActive.value) {
                highlight.cacheCurrentTextSelection();
            }
        },
        { passive: true },
    );
    useEventListener(
        documentTarget,
        'pointerup',
        (event) => {
            if (isActive.value && event instanceof PointerEvent) {
                highlight.handleDocumentPointerUp(event);
            }
        },
        { passive: true },
    );

    onMounted(() => {
        inlineIndicators.attachInlineCommentMarkerObserver();
        if (isActive.value) {
            scheduleLoadFromSource();
        }
    });

    watch(isActive, async (active) => {
        if (active) {
            await nextTick();
            scheduleSetAnnotationTool(annotationTool.value, 'restore annotation tool after tab activation');
            editor.applyAnnotationSettings(annotationSettings.value);
            if (src.value && !pdfDocument.value && !isLoading.value) {
                scheduleLoadFromSource();
                return;
            }
            if (pdfDocument.value && !isLoading.value) {
                updateVisibleRange(viewerContainer.value, numPages.value);
                void renderVisiblePages(visibleRange.value, { preserveRenderedPages: true });
                applySearchHighlights();
            }
            return;
        }
        cancelPendingSearchScroll?.();
        cancelInFlightPageRenders?.();
        cleanupRenderedPages();
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
            resetRenderStallRecoveryState();
            const isReload = !!oldSrc && !!newSrc;
            if (!newSrc) {
                emit('update:document', null);
                annotationCommentsCache.value = [];
                activeCommentStableKey.value = null;
                emit('annotation-comments', []);
            }
            if (!isActive.value) {
                return;
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

    watch(effectiveScale, (scale) => {
        if (!isActive.value) {
            return;
        }
        annotationUiManager.value?.onScaleChanging({scale: scale / PixelsPerInch.PDF_TO_CSS_UNITS});
    });

    watch(currentPage, (page) => {
        if (!isActive.value) {
            return;
        }
        annotationUiManager.value?.onPageChanging({ pageNumber: page });
        if (fitMode.value === 'height' && !continuousScroll.value && pdfDocument.value) {
            computeFitWidthScale(viewerContainer.value);
        }
    });

    watch(
        annotationTool,
        (tool) => {
            if (!isActive.value) {
                return;
            }
            if (tool !== 'none') highlight.cancelCommentPlacement();
            scheduleSetAnnotationTool(tool, `apply annotation tool "${tool}"`);
        },
        { immediate: true },
    );

    watch(annotationCursorMode, () => {
        if (!isActive.value) {
            return;
        }
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
            if (!isActive.value) {
                return;
            }
            editor.applyAnnotationSettings(annotationSettings.value);
        },
        {immediate: true},
    );

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
    };
};
