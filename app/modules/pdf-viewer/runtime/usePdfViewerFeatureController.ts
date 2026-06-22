import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type { GenericL10n } from 'pdfjs-dist/web/pdf_viewer.mjs';
import type { IPageRenderStallPayload } from '@app/modules/pdf-viewer/runtime/rendering/usePdfPageRenderer';
import { usePdfRenderViewModel } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRenderViewModel';
import { shouldShowPdfNavigationSkeleton } from '@app/modules/pdf-viewer/runtime/rendering/pdf-navigation-skeleton-eligibility/shouldShowPdfNavigationSkeleton';
import { usePdfMountedPageRenderRecovery } from '@app/modules/pdf-viewer/runtime/rendering/usePdfMountedPageRenderRecovery';
import { usePdfViewerRenderingRuntime } from '@app/modules/pdf-viewer/runtime/rendering/usePdfViewerRenderingRuntime';
import { usePdfAppAnnotationHistory } from '@app/modules/pdf-viewer/runtime/annotations/usePdfAppAnnotationHistory';
import { usePdfViewerRuntime } from '@app/modules/pdf-viewer/runtime/usePdfViewerRuntime';
import { usePdfSinglePageNavigationController } from '@app/modules/pdf-viewer/runtime/navigation/usePdfSinglePageNavigationController';
import { usePdfViewportViewModel } from '@app/modules/pdf-viewer/runtime/viewport/usePdfViewportViewModel';
import { usePdfViewerViewportLifecycle } from '@app/modules/pdf-viewer/runtime/viewport/usePdfViewerViewportLifecycle';
import { usePdfViewerRuntimeLifecycle } from '@app/modules/pdf-viewer/runtime/lifecycle/usePdfViewerRuntimeLifecycle';
import { usePdfViewerExposeControllers } from '@app/modules/pdf-viewer/runtime/usePdfViewerExposeControllers';
import { usePdfViewerLoadLifecycleController } from '@app/modules/pdf-viewer/runtime/lifecycle/usePdfViewerLoadLifecycleController';
import { usePdfViewerNavigationDiagnostics } from '@app/modules/pdf-viewer/runtime/lifecycle/usePdfViewerNavigationDiagnostics';
import { usePdfViewerSourceChangeLifecycle } from '@app/modules/pdf-viewer/runtime/lifecycle/usePdfViewerSourceChangeLifecycle';
import { usePdfViewerAnnotationRuntime } from '@app/modules/pdf-viewer/runtime/annotations/usePdfViewerAnnotationRuntime';
import type { IZoomVirtualizationFreeze } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerVirtualization';
import { usePdfViewerMouseInteractions } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerMouseInteractions';
import { usePdfViewerWheelZoom } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerWheelZoom';
import { usePdfViewerOutputScale } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerOutputScale';
import { createPdfViewerEventAdapter } from '@app/modules/pdf-viewer/runtime/contracts/createPdfViewerEventAdapter';
import { usePdfViewerPublicApiController } from '@app/modules/pdf-viewer/runtime/usePdfViewerPublicApiController';
import { useEditedTextMarkupVisualSync } from '@app/modules/pdf-viewer/runtime/annotations/useEditedTextMarkupVisualSync';
import type {
    IPdfViewerProps,
    IPdfViewerEmit,
} from '@app/modules/pdf-viewer/runtime/contracts/pdfViewerComponent.types';
import { usePdfViewerPropModel } from '@app/modules/pdf-viewer/runtime/contracts/usePdfViewerPropModel';
import { usePdfCropSelection } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfCropSelection';
import { usePdfImagePlacement } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfImagePlacement';
import { usePdfRegionSnip } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfRegionSnip';
import { getPageRowBoundsForViewMode } from '@app/modules/pdf-viewer/engine/pdf-page-layout/getPageRowBoundsForViewMode';
import { usePdfViewerSelectionToolState } from '@app/modules/pdf-viewer/tools/public';
import { summarizeViewerMetrics } from '@app/modules/pdf-viewer/engine/pdf-viewer-metrics/summarizeViewerMetrics';
import { isStandaloneSpreadPage } from '@app/utils/pdfViewMode';
import { resolveBookmarkDestinationTarget } from '@app/utils/pdfOutlineHelpers';
import type {
    IAnnotationEditorState,
    IAnnotationModifiedPayload,
    ILinkAnnotation,
} from '@app/types/annotations';
import type { IPageRange } from '@app/types/pdf';
import { runGuardedTask } from '@app/utils/asyncGuard';

export const usePdfViewerFeatureController = (props: IPdfViewerProps, emit: IPdfViewerEmit) => {
    const {
        src,
        reloadSrc,
        sourcePdfData,
        suppressLoadingOverlay,
        bufferPages,
        isAnySaving,
        zoom,
        dragMode,
        fitMode,
        zoomMode,
        viewMode,
        isResizing,
        showAnnotations,
        annotationTool,
        annotationCursorMode,
        annotationKeepActive,
        annotationSettings,
        searchPageMatches,
        currentSearchMatch,
        currentSearchMatchNavigationId,
        requestedCurrentPage,
        workingCopyPath,
        continuousScroll,
        isActive,
        authorName,
    } = usePdfViewerPropModel(props);
    const emptyAnnotationEditorState: IAnnotationEditorState = {
        isEditing: false,
        isEmpty: true,
        hasSomethingToUndo: false,
        hasSomethingToRedo: false,
        hasSelectedEditor: false,
    };
    const pdfjsAnnotationEditorState = ref<IAnnotationEditorState>({ ...emptyAnnotationEditorState });
    const { t } = useTypedI18n();
    const viewerEvents = createPdfViewerEventAdapter(emit);
    function emitAnnotationModified(payload?: IAnnotationModifiedPayload) {
        viewerEvents.annotationModified(payload);
    }
    const viewerHost = ref<HTMLElement | null>(null);
    const viewerContainer = ref<HTMLElement | null>(null);
    const resizeTransitionVisible = ref(false);
    const resizeTransitionAnchorPage = ref<number | null>(null);
    const annotationUiManager = shallowRef<AnnotationEditorUIManager | null>(null);
    const annotationL10n = shallowRef<GenericL10n | null>(null);
    const appAnnotationHistory = usePdfAppAnnotationHistory({
        pdfjsAnnotationState: pdfjsAnnotationEditorState,
        emitAnnotationState: viewerEvents.annotationState,
        markModified: emitAnnotationModified,
    });
    const zoomVirtualizationFreeze = ref<IZoomVirtualizationFreeze | null>(null);
    const renderedPageStateVersion = ref(0);
    const regionSnip = usePdfRegionSnip({ viewerContainer });
    const cropSelection = usePdfCropSelection({ viewerContainer });
    const {
        waitForViewerLoadSettled,
        cancelInitialVisualReady,
        handleRenderedPageStateChanged,
        handlePageCanvasMounted,
        handlePageRendered,
        onDocumentLoadStateChange,
    } = usePdfViewerLoadLifecycleController({
        renderedPageStateVersion,
        getAnnotationRuntime: () => annotationRuntime,
        emitInitialVisualPending: viewerEvents.initialVisualPending,
        emitInitialVisualReady: viewerEvents.initialVisualReady,
        markDelayedSkeletonPageRendered: pageNumber => markDelayedSkeletonPageRendered(pageNumber),
    });
    const viewerRuntime = usePdfViewerRuntime({
        viewerContainer,
        zoom,
        zoomMode,
        fitMode,
        viewMode,
        continuousScroll,
        emitEffectiveZoom: viewerEvents.updateEffectiveZoom,
        summarizeViewerStateForLog,
    });
    const pdfDocumentResult = viewerRuntime.document;
    const {
        pdfDocument,
        numPages,
        isLoading,
        basePageWidth,
        basePageHeight,
        pageMetrics,
        pageMetricsVersion,
    } = pdfDocumentResult;
    function summarizeViewerStateForLog() {
        return summarizeViewerMetrics(viewerContainer.value);
    }
    const {
        clearPinnedViewportPage,
        pinCurrentPageDuringRecovery,
    } = viewerRuntime.viewportPin;
    const {
        currentPage: viewerCurrentPage,
        visibleRange,
        getMostVisiblePage,
        scrollToPage: scrollToPageInternal,
        updateCurrentPage,
        updateVisibleRange,
        setPageLayoutMetrics,
    } = viewerRuntime.scroll;
    const {
        containerStyle: scaleContainerStyle,
        scaledMargin,
        computeFitWidthScale,
        effectiveScale,
        isFitWidthScaleCurrent,
        invalidateScaleCache,
        resetScale,
    } = viewerRuntime.scale;
    const {
        isVisualReloadTransitionActive,
        beginVisualReloadTransition,
        endVisualReloadTransition,
    } = viewerRuntime.reloadTransition;
    const {
        skeletonContentInsets,
        computeSkeletonInsets,
        resetInsets,
    } = viewerRuntime.skeletonInsets;
    let pageRenderStallRecoveryHandler: ((payload: IPageRenderStallPayload) => void) | null = null;
    const annotationRuntime = usePdfViewerAnnotationRuntime({
        viewerContainer,
        src,
        sourcePdfData,
        workingCopyPath,
        isAnySaving,
        bufferPages,
        pdfDocument,
        numPages,
        currentPage: viewerCurrentPage,
        visibleRange,
        effectiveScale,
        annotationTool,
        annotationCursorMode,
        annotationKeepActive,
        annotationSettings,
        annotationUiManager,
        annotationL10n,
        renderedPageStateVersion,
        authorName,
        appAnnotationHistory,
        pdfjsAnnotationEditorState,
        stopDrag: () => stopDrag(),
        scrollToPage: (pageNumber, options) => singlePageScroll.scrollToPage(pageNumber, options),
        updateVisibleRange,
        renderVisiblePages: (range, options) => renderVisiblePages(range, options),
        renderAnnotationEditorLayerForPage: pageNumber => renderAnnotationEditorLayerForPage(pageNumber),
        isPageRendered: pageNumber => isPageRendered(pageNumber),
        invalidatePages: pages => invalidateRenderedPages(pages),
        hideManagedAnnotationEditors: pageNumber => hideManagedAnnotationEditors(pageNumber),
        emitAnnotationModified,
        emitAnnotationComments: viewerEvents.annotationComments,
        emitAnnotationOpenNote: viewerEvents.annotationOpenNote,
        emitAnnotationContextMenu: viewerEvents.annotationContextMenu,
        emitAnnotationToolAutoReset: viewerEvents.annotationToolAutoReset,
        emitAnnotationSetting: viewerEvents.annotationSetting,
        emitAnnotationCommentClick: viewerEvents.annotationCommentClick,
        emitAnnotationToolCancel: viewerEvents.annotationToolCancel,
        emitAnnotationNotePlacementChange: viewerEvents.annotationNotePlacementChange,
        emitShapeContextMenu: viewerEvents.shapeContextMenu,
    });
    const {
        annotations,
        annotationCommentsCache,
        activeCommentStableKey,
        managedEmbeddedPdfShapes,
        managedEmbeddedAnnotationIds,
        renderHiddenEmbeddedAnnotationIds,
        highlightComposable,
        commentCrud,
        markersByPage,
        linksByPage,
        setUndoPdfjsAnnotationHandler,
        setRedoPdfjsAnnotationHandler,
        handleSourceChanged: handleAnnotationSourceChanged,
        handleMarkerOpenNote,
        handleMarkerContextMenu,
        handleMarkerMove,
    } = annotationRuntime;
    function relayPageRenderStall(payload: IPageRenderStallPayload) {
        pageRenderStallRecoveryHandler?.(payload);
    }
    const {
        canvasHiddenAnnotationIds,
        applyEditedTextMarkupColorsForRenderedPage,
    } = useEditedTextMarkupVisualSync({
        viewerContainer,
        annotationCommentsCache,
        hiddenEmbeddedAnnotationIds: renderHiddenEmbeddedAnnotationIds,
        annotationSettings,
    });
    const outputScale = usePdfViewerOutputScale();
    function isFinitePageRange(range: IPageRange) {
        return Number.isFinite(range.start)
            && Number.isFinite(range.end)
            && range.start <= range.end;
    }

    function pageRangeContainsPage(range: IPageRange, pageNumber: number) {
        return isFinitePageRange(range)
            && pageNumber >= range.start
            && pageNumber <= range.end;
    }

    function pageRangesIntersect(left: IPageRange, right: IPageRange) {
        return isFinitePageRange(left)
            && isFinitePageRange(right)
            && left.start <= right.end
            && right.start <= left.end;
    }

    let isVisibleRenderRangeCurrent = (range: IPageRange) => (
        pageRangesIntersect(range, visibleRange.value)
    );
    let getNavigationRenderTargetPage = (): number | null => null;
    const {
        setupPagePlaceholders,
        renderVisiblePages,
        reRenderAllVisiblePages,
        invalidatePages: invalidateRenderedPages,
        applySearchHighlights,
        hideManagedAnnotationEditors,
        isPageRendered,
        isPageRendering,
        requestScrollToCurrentResult,
        cancelPendingSearchScroll,
        cancelInFlightRenders,
        renderAnnotationEditorLayerForPage,
        cleanupRenderedPages,
        isPageFreshlyRenderedForNavigation,
        isPageRenderedForClass,
    } = usePdfViewerRenderingRuntime({
        viewerContainer,
        document: pdfDocumentResult,
        currentPage: viewerCurrentPage,
        isActive,
        effectiveScale,
        outputScale,
        bufferPages,
        showAnnotations,
        hiddenAnnotationIds: renderHiddenEmbeddedAnnotationIds,
        canvasHiddenAnnotationIds,
        managedAnnotationIds: managedEmbeddedAnnotationIds,
        annotationUiManager,
        annotationL10n,
        scrollToPage: (pageNumber, options) => singlePageScroll.scrollToPage(pageNumber, options),
        suppressSnap: () => singlePageScroll.suppressSnapFor(220),
        beginSearchNavigation: (pageNumber) => {
            markUserViewportInteraction();
            singlePageScroll.beginSearchNavigation(pageNumber);
        },
        revealSearchNavigationTarget: (pageNumber, options) => singlePageScroll.revealSearchNavigationTarget(pageNumber, options),
        endSearchNavigation: (settleMs?: number) => singlePageScroll.endSearchNavigation(settleMs),
        searchPageMatches,
        currentSearchMatch,
        currentSearchMatchNavigationId,
        workingCopyPath,
        onRenderStall: relayPageRenderStall,
        isVisibleRenderRangeCurrent: range => isVisibleRenderRangeCurrent(range),
        onPageCanvasMounted: pageNumber => {
            handlePageCanvasMounted(pageNumber);
        },
        onPageRendered: pageNumber => {
            handlePageRendered(pageNumber);
            singlePageScroll.releasePagedNavigationHoldForPage(pageNumber);
        },
        onAnnotationLayersRendered: pageNumber => applyEditedTextMarkupColorsForRenderedPage(pageNumber),
        onRenderedPageStateChanged: handleRenderedPageStateChanged,
        renderedPageStateVersion,
    });
    isVisibleRenderRangeCurrent = (range: IPageRange) => {
        const targetPage = getNavigationRenderTargetPage();
        if (targetPage !== null && numPages.value > 0) {
            const targetRowBounds = getPageRowBoundsForViewMode({
                pageNumber: targetPage,
                viewMode: viewMode.value,
                totalPages: numPages.value,
            });
            return (
                pageRangesIntersect(range, targetRowBounds)
                || pageRangeContainsPage(range, targetPage)
            );
        }

        return pageRangesIntersect(range, visibleRange.value);
    };
    watch(outputScale, (nextScale, previousScale) => {
        if (nextScale === previousScale || !pdfDocument.value || isLoading.value) {
            return;
        }

        runGuardedTask(
            () => reRenderAllVisiblePages(() => visibleRange.value, {
                preserveExistingPages: true,
                rerenderSource: 'dpr-change',
                renderBufferOverride: 0,
            }),
            {
                scope: 'pdf-viewer',
                message: 'Failed to re-render PDF pages after display scale change',
            },
        );
    });
    /**
     * In paged fit-height/fit-width mode, current-page changes are rendered by
     * `usePdfViewerRerenderCoordinator` after it hydrates the destination page
     * metrics and recomputes scale. The generic paged row render would draw the
     * same target at the previous scale first, then get cancelled by the fit
     * rerender; on the 422 MB Girgas PDF that same-page cancel/restart was the
     * source of the infinite last-page skeleton.
     */
    function shouldSuppressPagedFitRowRender() {
        return (
            !continuousScroll.value
            && !isResizing.value
            && (
                (fitMode.value === 'height' && zoomMode.value === 'fit-height')
                || (fitMode.value === 'width' && zoomMode.value === 'fit-width')
            )
        );
    }
    function isUsablePageMetric(pageNumber: number) {
        const metric = pageMetrics.value[pageNumber - 1];
        return typeof metric?.width === 'number'
            && Number.isFinite(metric.width)
            && metric.width > 0
            && typeof metric.height === 'number'
            && Number.isFinite(metric.height)
            && metric.height > 0;
    }
    function getPageRangeNumbers(startPage: number, endPage: number) {
        const pages: number[] = [];
        for (let pageNumber = startPage; pageNumber <= endPage; pageNumber += 1) {
            pages.push(pageNumber);
        }
        return pages;
    }
    function isTargetRowMetricReady(startPage: number, endPage: number) {
        return getPageRangeNumbers(startPage, endPage).every(isUsablePageMetric);
    }
    function applyPreparedPagedTargetLayout(pageNumber: number, startPage: number, endPage: number) {
        const didScaleChange = computeFitWidthScale(viewerContainer.value, { page: pageNumber });
        setupPagePlaceholders();
        if (didScaleChange) {
            invalidateRenderedPages(getPageRangeNumbers(startPage, endPage));
        }
    }
    function preparePagedTargetLayout(
        pageNumber: number,
        shouldContinue: () => boolean,
    ) {
        if (!shouldSuppressPagedFitRowRender() || numPages.value <= 0) {
            return;
        }

        const rowBounds = getPageRowBoundsForViewMode({
            pageNumber,
            viewMode: viewMode.value,
            totalPages: numPages.value,
        });
        if (isTargetRowMetricReady(rowBounds.start, rowBounds.end)) {
            applyPreparedPagedTargetLayout(pageNumber, rowBounds.start, rowBounds.end);
            return;
        }

        return (async () => {
            await pdfDocumentResult.ensurePageMetricsInRange(rowBounds.start, rowBounds.end);
            await nextTick();
            if (!shouldContinue() || !shouldSuppressPagedFitRowRender()) {
                return;
            }
            applyPreparedPagedTargetLayout(pageNumber, rowBounds.start, rowBounds.end);
        })();
    }
    const singlePageScroll = usePdfSinglePageNavigationController({
        viewerContainer,
        numPages,
        currentPage: viewerCurrentPage,
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
        ensurePageMetricsInRange: pdfDocumentResult.ensurePageMetricsInRange,
        preparePagedTargetLayout,
        suppressPagedRowRender: shouldSuppressPagedFitRowRender,
        isPageFreshlyRenderedForNavigation,
        visibleRange,
        emitCurrentPage: viewerEvents.updateCurrentPage,
        emitNavigationFeedbackPage: viewerEvents.updateNavigationFeedbackPage,
        requestedCurrentPage,
        cancelPendingSearchScroll,
    });
    getNavigationRenderTargetPage = () => (
        singlePageScroll.pagedNavigationTargetPage.value
        ?? singlePageScroll.searchNavigationTargetPage.value
        ?? singlePageScroll.continuousNavigationTargetPage.value
    );
    const { navigationAnchorPage } = singlePageScroll;
    const userViewportInteractionEpoch = ref(0);

    function markUserViewportInteraction() {
        userViewportInteractionEpoch.value += 1;
        singlePageScroll.cancelProgrammaticNavigation();
    }

    function handleLinkDestination(dest: NonNullable<ILinkAnnotation['dest']>) {
        runGuardedTask(async () => {
            const document = pdfDocument.value;
            if (!document) {
                return;
            }

            const target = await resolveBookmarkDestinationTarget(document, dest);
            if (!target) {
                return;
            }

            singlePageScroll.scrollToPage(
                target.page,
                typeof target.pageYRatio === 'number'
                    ? { pageYRatio: target.pageYRatio }
                    : undefined,
            );
        }, {
            scope: 'pdf-viewer',
            message: 'Failed to navigate PDF link destination',
        });
    }

    const {
        pendingImagePlacement,
        isPendingImagePlacementFinalizing,
        startImagePlacement,
        updatePendingImagePlacementRect,
        requestPendingImagePlacementFinalize,
        clearPendingImagePlacement,
        restorePendingImagePlacement,
    } = usePdfImagePlacement({
        viewerContainer,
        currentPage: viewerCurrentPage,
        numPages,
        effectiveScale,
        emitFinalize: viewerEvents.imagePlacementFinalize,
    });
    const {
        isDragging,
        startDrag,
        onDrag,
        stopDrag,
        isViewerPanDragModeActive,
        isSelectionMarkupToolActive,
        isTextSelectionModeActive,
        selectionMarkupStyle,
    } = usePdfViewerSelectionToolState({
        dragMode,
        annotationTool,
        annotationCursorMode,
        annotationSettings,
        pendingImagePlacement,
    });
    const isPlacementInactivePanDragModeActive = computed(() =>
        isViewerPanDragModeActive.value && !highlightComposable.isPlacingComment.value,
    );
    const isPlacementInactiveSelectionMarkupToolActive = computed(() =>
        isSelectionMarkupToolActive.value && !highlightComposable.isPlacingComment.value,
    );
    const isPlacementInactiveTextSelectionModeActive = computed(() =>
        isTextSelectionModeActive.value && !highlightComposable.isPlacingComment.value,
    );
    const zoomSnapSuppressedForClass = ref(false);
    const {
        pageLayout,
        getPagePlaceholderStyle,
        virtualizedContinuousMode,
        navigationAnchorWindow,
        virtualWindowStart,
        virtualWindowEnd,
        topVirtualSpacerStyle,
        bottomVirtualSpacerStyle,
        pagesToRender,
        isPageBuffered,
        containerStyle,
        viewerClass,
        resolveHorizontalScrollClampForActiveSpread,
        syncHorizontalScrollForZoomMode,
    } = usePdfViewportViewModel({
        viewerContainer,
        bufferPages,
        viewMode,
        numPages,
        currentPage: viewerCurrentPage,
        continuousScroll,
        basePageWidth,
        basePageHeight,
        pageMetrics,
        pageMetricsVersion,
        effectiveScale,
        scaledMargin,
        visibleRange,
        navigationAnchorPage,
        resizeTransitionAnchorPage,
        zoomVirtualizationFreeze,
        scaleContainerStyle,
        selectionMarkupStyle,
        classState: {
            isAnySaving,
            isDragging,
            isViewerPanDragModeActive: isPlacementInactivePanDragModeActive,
            isPlacingComment: highlightComposable.isPlacingComment,
            isSelectionMarkupToolActive: isPlacementInactiveSelectionMarkupToolActive,
            isTextSelectionModeActive: isPlacementInactiveTextSelectionModeActive,
            fitMode,
            zoomMode,
            resizeTransitionVisible,
            zoomSnapSuppressed: zoomSnapSuppressedForClass,
        },
    });
    const {
        zoomSnapSuppressed: wheelZoomSnapSuppressed,
        handleViewerWheel,
        handleViewerScroll,
        consumeZoomViewportAnchor,
        isZoomInteractionLocked,
        setZoomRerenderBusy,
    } = usePdfViewerWheelZoom({
        viewerContainer,
        src,
        isLoading,
        zoom,
        zoomMode,
        effectiveScale,
        currentPage: viewerCurrentPage,
        visibleRange,
        virtualizedContinuousMode,
        virtualWindowStart,
        virtualWindowEnd,
        zoomVirtualizationFreeze,
        singlePageScroll,
        cancelPendingSearchScroll,
        markUserViewportInteraction,
        isSnipActive: () => regionSnip.isActive.value || cropSelection.isSelecting.value,
        emit,
    });
    watch(
        wheelZoomSnapSuppressed,
        value => {
            zoomSnapSuppressedForClass.value = value;
        },
        { immediate: true },
    );
    const isCurrentPageFitRerenderTransitionActive = ref(false);
    usePdfViewerSourceChangeLifecycle({
        src,
        isAnySaving,
        clearAnnotationHistory: appAnnotationHistory.clear,
        clearPendingImagePlacement,
        handleAnnotationSourceChanged,
    });
    const {
        handleResizeTransitionSignal,
        handleViewerContainerRef,
        handleViewportScroll,
    } = usePdfViewerViewportLifecycle({
        src,
        isLoading,
        viewerHost,
        viewerContainer,
        resizeTransitionVisible,
        resizeTransitionAnchorPage,
        currentPage: viewerCurrentPage,
        visibleRange,
        continuousScroll,
        fitMode,
        zoomMode,
        zoom,
        effectiveScale,
        viewMode,
        numPages,
        pageMetricsVersion,
        pageLayout,
        clearPinnedViewportPage,
        clearPendingImagePlacement,
        setPageLayoutMetrics,
        syncHorizontalScrollForZoomMode,
        handleViewerScroll,
        summarizeViewerStateForLog,
        loadingLabel: () => t('common.loading'),
    });
    const runtimeLifecycle = usePdfViewerRuntimeLifecycle({
        viewerContainer,
        src,
        reloadSrc,
        zoom,
        zoomMode,
        fitMode,
        viewMode,
        isResizing,
        isActive,
        continuousScroll,
        annotationTool,
        annotationCursorMode,
        annotationSettings,
        isAnySaving,
        annotationUiManager,
        annotationCommentsCache,
        activeCommentStableKey,
        pdfDocumentResult,
        annotations,
        currentPage: viewerCurrentPage,
        pagedNavigationTargetPage: singlePageScroll.pagedNavigationTargetPage,
        navigationAnchorPage,
        visibleRange,
        effectiveScale,
        basePageWidth,
        basePageHeight,
        computeFitWidthScale,
        syncHorizontalScrollForZoomMode,
        invalidateScaleCache,
        resetScale,
        computeSkeletonInsets,
        beforeInitialRender: managedEmbeddedPdfShapes.importBeforeInitialRender,
        resetInsets,
        setupPagePlaceholders,
        renderVisiblePages,
        reRenderAllVisiblePages,
        cancelInFlightPageRenders: cancelInFlightRenders,
        cancelPendingSearchScroll,
        cleanupRenderedPages,
        invalidateRenderedPages,
        applySearchHighlights,
        isPageRendered,
        getMostVisiblePage,
        updateCurrentPage,
        updateVisibleRange,
        scrollToPage: (
            pageNumber,
            options,
        ) => singlePageScroll.scrollToPage(pageNumber, options),
        resetContinuousScrollState: () => singlePageScroll.resetContinuousScrollState(),
        cancelDestinationNavigationTarget: () => singlePageScroll.cancelProgrammaticNavigation(),
        getUserViewportInteractionEpoch: () => userViewportInteractionEpoch.value,
        cancelInitialVisualReady,
        startDrag,
        onDrag,
        stopDrag,
        consumeZoomViewportAnchor,
        isZoomInteractionLocked,
        isZoomGestureSessionLocked: isZoomInteractionLocked,
        setZoomRerenderBusy,
        setResizeTransitionVisible: handleResizeTransitionSignal,
        pinCurrentPageDuringRecovery,
        beginVisualReloadTransition,
        endVisualReloadTransition,
        setCurrentPageFitRerenderTransitionActive: active => {
            isCurrentPageFitRerenderTransitionActive.value = active;
        },
        onDocumentLoadStateChange,
        emit,
    });
    setUndoPdfjsAnnotationHandler(runtimeLifecycle.undoAnnotation);
    setRedoPdfjsAnnotationHandler(runtimeLifecycle.redoAnnotation);
    pageRenderStallRecoveryHandler = runtimeLifecycle.handlePageRenderStall;

    function undoAnnotation() {
        if (appAnnotationHistory.canUndo.value) {
            appAnnotationHistory.undo({ undoPdfjs: runtimeLifecycle.undoAnnotation });
            return;
        }
        runtimeLifecycle.undoAnnotation();
    }

    function redoAnnotation() {
        if (appAnnotationHistory.canRedo.value) {
            appAnnotationHistory.redo({ redoPdfjs: runtimeLifecycle.redoAnnotation });
            return;
        }
        runtimeLifecycle.redoAnnotation();
    }

    const {
        shouldShowSkeleton,
        handleDragStart,
        handleDragMove,
        invalidatePages,
        preserveNextSourceReloadVisibleContent,
    } = runtimeLifecycle;
    const navigationSkeletonAnchorPage = computed(() =>
        navigationAnchorPage.value ?? viewerCurrentPage.value,
    );
    const skeletonTrackedPages = computed(() => {
        const trackedPages = new Set(pagesToRender.value);
        if (numPages.value > 0) {
            const rowBounds = getPageRowBoundsForViewMode({
                pageNumber: navigationSkeletonAnchorPage.value,
                viewMode: viewMode.value,
                totalPages: numPages.value,
            });
            for (let pageNumber = rowBounds.start; pageNumber <= rowBounds.end; pageNumber += 1) {
                trackedPages.add(pageNumber);
            }
        }
        return [...trackedPages].sort((left, right) => left - right);
    });
    function hasMountedPageCanvas(pageNumber: number) {
        return Boolean(
            viewerContainer.value?.querySelector(
                `.page_container[data-page="${pageNumber}"] .page_canvas canvas`,
            ),
        );
    }
    function hasMountedPageContainer(pageNumber: number) {
        return Boolean(
            viewerContainer.value?.querySelector(
                `.page_container[data-page="${pageNumber}"]`,
            ),
        );
    }
    function isPageVisualReadyForShapeOverlay(pageNumber: number) {
        return (
            isPageFreshlyRenderedForNavigation(pageNumber)
            && hasMountedPageCanvas(pageNumber)
        );
    }
    function isPageVisuallyReady(pageNumber: number) {
        return (
            isPageRenderedForClass(pageNumber)
            || (
                hasMountedPageCanvas(pageNumber)
                && isPageRendering(pageNumber)
            )
        );
    }
    const shouldShowNavigationSkeleton = (pageNumber: number) => shouldShowPdfNavigationSkeleton({
        pageNumber,
        navigationAnchorPage: navigationSkeletonAnchorPage.value,
        totalPages: numPages.value,
        viewMode: viewMode.value,
        isPageRendered: isPageVisuallyReady,
        shouldShowSkeleton,
    });
    const { queueMountedPageRender: handlePageContainerMounted } = usePdfMountedPageRenderRecovery({
        isActive,
        isLoading,
        hasDocument: computed(() => Boolean(pdfDocument.value)),
        numPages,
        suppressRecovery: isCurrentPageFitRerenderTransitionActive,
        isPageMounted: hasMountedPageContainer,
        shouldRecoverPage: pageNumber => (
            shouldShowNavigationSkeleton(pageNumber)
            && !isPageVisuallyReady(pageNumber)
            && !isPageRendering(pageNumber)
        ),
        resolveRecoveryRange: pageNumber => (
            pageNumber >= visibleRange.value.start && pageNumber <= visibleRange.value.end
                ? visibleRange.value
                : {
                    start: pageNumber,
                    end: pageNumber,
                }
        ),
        renderVisiblePages,
    });
    const {
        handleViewerMouseDown,
        handleViewerMouseMove,
        handleViewerMouseUp,
        handleViewerMouseLeave,
        handleSelectStart,
        handleViewerClick,
        handleViewerDblClick,
        handleViewerContextMenu,
    } = usePdfViewerMouseInteractions({
        isSnipActive: () => regionSnip.isActive.value || cropSelection.isSelecting.value,
        isCommentPlacementActive: () => highlightComposable.isPlacingComment.value,
        isViewerPanDragModeActive,
        markUserViewportInteraction,
        cancelPendingSearchScroll,
        handleDragStart,
        handleDragMove,
        stopDrag,
        handleViewerMouseUpAnnotation: () => highlightComposable.handleViewerMouseUp(),
        handleViewerClickAnnotation: (event) => commentCrud.handleAnnotationCommentClick(event),
        handleViewerDblClickAnnotation: (event) => commentCrud.handleAnnotationEditorDblClick(event),
        handleViewerContextMenuAnnotation: (event) => commentCrud.handleAnnotationCommentContextMenu(event),
    });
    const renderViewModel = usePdfRenderViewModel({
        src,
        isLoading,
        pdfDocument,
        getPage: pdfDocumentResult.getPage,
        viewerContainer,
        isVisualReloadTransitionActive,
        suppressLoadingOverlay,
        suppressPagedBufferRender: isCurrentPageFitRerenderTransitionActive,
        skeletonContentInsets,
        pagesToRender,
        skeletonTrackedPages,
        isPageBuffered,
        isPageRenderedForClass,
        isPageRendering,
        hasMountedPageCanvas,
        shouldShowSkeletonImmediately: pageNumber => (
            navigationAnchorPage.value !== null
            && shouldShowNavigationSkeleton(pageNumber)
        ),
        shouldShowSkeleton: shouldShowNavigationSkeleton,
        visibleRange,
        pagedNavigationTargetPage: singlePageScroll.pagedNavigationTargetPage,
        currentPage: viewerCurrentPage,
        zoom,
        zoomMode,
        fitMode,
        effectiveScale,
        continuousScroll,
        numPages,
        isPagedNavigationBurstActive: () => singlePageScroll.isPagedNavigationBurstActive(),
        markersByPage,
        linksByPage,
        renderVisiblePages,
        runGuardedTask,
    });
    const {
        visibleMarkersByPage,
        visibleLinksByPage,
        shouldShowPageSkeleton,
        markPageRendered: markDelayedSkeletonPageRendered,
    } = renderViewModel;
    usePdfViewerNavigationDiagnostics({
        currentPage: viewerCurrentPage,
        visibleRange,
        isLoading,
        continuousScroll,
        fitMode,
        viewMode,
        zoom,
        navigationAnchorWindow,
        virtualizedContinuousMode,
        virtualWindowStart,
        virtualWindowEnd,
        searchNavigationTargetPage: singlePageScroll.searchNavigationTargetPage,
        searchNavigationState: singlePageScroll.searchNavigationState,
        summarizeViewerStateForLog,
    });
    function isSpreadSingle(page: number) {
        return isStandaloneSpreadPage(page, viewMode.value, numPages.value);
    }
    function getPagePreview(page: number) {
        // Main-page low-res previews were removed from navigation authority;
        // keep the public hook as a null provider for thumbnail compatibility.
        void page;
        return null;
    }
    const {
        captureViewerScrollSnapshot,
        restoreViewerScrollSnapshot,
        applyFitWidthToCurrentPage,
        saveViewerDocument,
        renderLoadedPdfPagesForBrowserPrint,
    } = usePdfViewerExposeControllers({
        viewerContainer,
        currentPage: viewerCurrentPage,
        pdfDocument,
        annotationUiManager,
        isLoading,
        continuousScroll,
        fitMode,
        zoomMode,
        zoom,
        effectiveScale,
        viewMode,
        numPages,
        pageMetricsVersion,
        visibleRange,
        resolveHorizontalScrollClampForActiveSpread,
        syncHorizontalScrollForZoomMode,
        scrollToPage: singlePageScroll.scrollToPage,
        computeFitWidthScale,
        isFitWidthScaleCurrent,
        cancelInFlightRenders,
        reRenderAllVisiblePages,
        emitZoomMode: viewerEvents.updateZoomMode,
    });
    const pdfViewerPublicApi = usePdfViewerPublicApiController({
        viewerContainer,
        viewerRuntime,
        singlePageScroll,
        getUserViewportInteractionEpoch: () => userViewportInteractionEpoch.value,
        cancelPendingSearchScroll,
        annotationRuntime,
        appAnnotationHistory,
        captureViewerScrollSnapshot,
        restoreViewerScrollSnapshot,
        applyFitWidthToCurrentPage,
        waitForViewerLoadSettled,
        renderVisiblePages,
        preserveNextSourceReloadVisibleContent,
        getPagePreview,
        saveViewerDocument,
        renderLoadedPdfPagesForBrowserPrint,
        undoAnnotation,
        redoAnnotation,
        startImagePlacement,
        clearPendingImagePlacement,
        restorePendingImagePlacement,
        invalidatePages,
        captureRegionToClipboard: regionSnip.startCaptureSession,
        isCapturingRegion: regionSnip.isActive,
        startCropSelection: cropSelection.startCropSelection,
        cancelCropSelection: cropSelection.cancelSelection,
        isCropSelecting: cropSelection.isSelecting,
        requestScrollToCurrentResult,
    });
    return {
        t,
        viewerHost,
        viewerContainer,
        annotationUiManager,
        viewerClass,
        containerStyle,
        pagesToRender,
        shouldShowPageSkeleton,
        isSpreadSingle,
        isPageBuffered,
        isPageRenderedForClass,
        isPageVisualReadyForShapeOverlay,
        getPagePreview,
        getPagePlaceholderStyle,
        topVirtualSpacerStyle,
        bottomVirtualSpacerStyle,
        pendingImagePlacement,
        isPendingImagePlacementFinalizing,
        handleViewportScroll,
        handleViewerWheel,
        handleViewerMouseDown,
        handleViewerMouseMove,
        handleViewerMouseUp,
        handleViewerMouseLeave,
        handleViewerClick,
        handleViewerDblClick,
        handleViewerContextMenu,
        handleSelectStart,
        handlePageContainerMounted,
        updatePendingImagePlacementRect,
        requestPendingImagePlacementFinalize,
        clearPendingImagePlacement,
        regionSnip,
        cropSelection,
        visibleMarkersByPage,
        visibleLinksByPage,
        handleMarkerOpenNote,
        handleMarkerContextMenu,
        handleMarkerMove,
        handleLinkDestination,
        handleViewerContainerRef,
        pdfViewerPublicApi,
    };
};
