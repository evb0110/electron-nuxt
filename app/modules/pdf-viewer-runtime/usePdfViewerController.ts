import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type { GenericL10n } from 'pdfjs-dist/web/pdf_viewer.mjs';
import type { IPageRenderStallPayload } from '@app/modules/pdf-viewer-runtime/rendering/usePdfPageRenderingController';
import { usePdfRenderViewModel } from '@app/modules/pdf-viewer-runtime/rendering/usePdfRenderViewModel';
import { usePdfViewerRenderingRuntime } from '@app/modules/pdf-viewer-runtime/rendering/usePdfViewerRenderingRuntime';
import { usePdfImagePlacementTool } from '@app/modules/pdf-viewer-tools/usePdfImagePlacementTool';
import { usePdfAppAnnotationHistory } from '@app/composables/pdf/usePdfAppAnnotationHistory';
import { usePdfViewerRuntime } from '@app/modules/pdf-viewer-runtime/usePdfViewerRuntime';
import { usePdfSinglePageNavigationController } from '@app/modules/pdf-viewer-runtime/navigation/usePdfSinglePageNavigationController';
import { usePdfViewportViewModel } from '@app/modules/pdf-viewer-runtime/viewport/usePdfViewportViewModel';
import { usePdfViewerViewportLifecycle } from '@app/modules/pdf-viewer-runtime/viewport/usePdfViewerViewportLifecycle';
import { usePdfViewerCoreController } from '@app/modules/pdf-viewer-runtime/usePdfViewerCoreController';
import { usePdfViewerExposeControllers } from '@app/modules/pdf-viewer-runtime/usePdfViewerExposeControllers';
import { usePdfViewerLoadLifecycleController } from '@app/modules/pdf-viewer-runtime/lifecycle/usePdfViewerLoadLifecycleController';
import { usePdfViewerNavigationDiagnostics } from '@app/modules/pdf-viewer-runtime/lifecycle/usePdfViewerNavigationDiagnostics';
import { usePdfViewerSourceChangeLifecycle } from '@app/modules/pdf-viewer-runtime/lifecycle/usePdfViewerSourceChangeLifecycle';
import { usePdfViewerAnnotationRuntime } from '@app/modules/pdf-viewer-runtime/annotations/usePdfViewerAnnotationRuntime';
import type { IZoomVirtualizationFreeze } from '@app/modules/pdf-viewer-runtime/composables/usePdfViewerVirtualization';
import { usePdfViewerMouseInteractions } from '@app/modules/pdf-viewer-runtime/composables/usePdfViewerMouseInteractions';
import { usePdfViewerWheelZoom } from '@app/modules/pdf-viewer-runtime/composables/usePdfViewerWheelZoom';
import { createPdfViewerEventAdapter } from '@app/modules/pdf-viewer-runtime/contracts/createPdfViewerEventAdapter';
import { usePdfViewerPublicApiController } from '@app/modules/pdf-viewer-runtime/usePdfViewerPublicApiController';
import type {
    IPdfViewerProps,
    TPdfViewerEmit,
} from '@app/modules/pdf-viewer-runtime/contracts/pdfViewerComponent.types';
import { usePdfViewerPropModel } from '@app/modules/pdf-viewer-runtime/contracts/usePdfViewerPropModel';
import { usePdfRegionSnipTool } from '@app/modules/pdf-viewer-tools/usePdfRegionSnipTool';
import { usePdfCropTool } from '@app/modules/pdf-viewer-tools/usePdfCropTool';
import { usePdfViewerSelectionToolState } from '@app/modules/pdf-viewer-tools/usePdfViewerSelectionToolState';
import { summarizeViewerMetrics } from '@app/composables/pdf/pdfViewerMetrics';
import { isStandaloneSpreadPage } from '@app/utils/pdfViewMode';
import type {
    IAnnotationEditorState,
    IAnnotationModifiedPayload,
} from '@app/types/annotations';
import { runGuardedTask } from '@app/utils/asyncGuard';
export function usePdfViewerController(props: IPdfViewerProps, emit: TPdfViewerEmit) {
    const {
        src,
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
        invertColors,
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
    const regionSnip = usePdfRegionSnipTool({ viewerContainer });
    const cropSelection = usePdfCropTool({ viewerContainer });
    const {
        waitForViewerLoadSettled,
        handleRenderedPageStateChanged,
        handlePageCanvasMounted,
        handlePageRendered,
        onDocumentLoadStateChange,
    } = usePdfViewerLoadLifecycleController({
        renderedPageStateVersion,
        getAnnotationRuntime: () => annotationRuntime,
        getSinglePageScroll: () => singlePageScroll,
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
        hiddenEmbeddedAnnotationIds,
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
        setupPagePlaceholders,
        renderVisiblePages,
        reRenderAllVisiblePages,
        invalidatePages: invalidateRenderedPages,
        applySearchHighlights,
        hideManagedAnnotationEditors,
        isPageRendered,
        requestScrollToCurrentResult,
        cancelPendingSearchScroll,
        cancelInFlightRenders,
        renderAnnotationEditorLayerForPage,
        cleanupRenderedPages,
        isPageRenderedForClass,
    } = usePdfViewerRenderingRuntime({
        viewerContainer,
        document: pdfDocumentResult,
        currentPage: viewerCurrentPage,
        isActive,
        effectiveScale,
        bufferPages,
        showAnnotations,
        hiddenAnnotationIds: hiddenEmbeddedAnnotationIds,
        managedAnnotationIds: managedEmbeddedAnnotationIds,
        annotationUiManager,
        annotationL10n,
        scrollToPage: (pageNumber, options) => singlePageScroll.scrollToPage(pageNumber, options),
        suppressSnap: () => singlePageScroll.suppressSnapFor(220),
        beginSearchNavigation: (pageNumber: number) => singlePageScroll.beginSearchNavigation(pageNumber),
        endSearchNavigation: (settleMs?: number) => singlePageScroll.endSearchNavigation(settleMs),
        searchPageMatches,
        currentSearchMatch,
        currentSearchMatchNavigationId,
        workingCopyPath,
        onRenderStall: relayPageRenderStall,
        onPageCanvasMounted: handlePageCanvasMounted,
        onPageRendered: handlePageRendered,
        onRenderedPageStateChanged: handleRenderedPageStateChanged,
        renderedPageStateVersion,
    });
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
        visibleRange,
        emitCurrentPage: viewerEvents.updateCurrentPage,
        requestedCurrentPage,
        cancelPendingSearchScroll,
    });
    const { navigationAnchorPage } = singlePageScroll;
    const {
        pendingImagePlacement,
        isPendingImagePlacementFinalizing,
        startImagePlacement,
        updatePendingImagePlacementRect,
        requestPendingImagePlacementFinalize,
        clearPendingImagePlacement,
        restorePendingImagePlacement,
    } = usePdfImagePlacementTool({
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
            isViewerPanDragModeActive,
            isPlacingComment: highlightComposable.isPlacingComment,
            isSelectionMarkupToolActive,
            isTextSelectionModeActive,
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
        topVirtualSpacerStyle,
        bottomVirtualSpacerStyle,
        zoomVirtualizationFreeze,
        singlePageScroll,
        cancelPendingSearchScroll,
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
    const {
        shouldShowSkeleton,
        handleDragStart,
        handleDragMove,
        undoAnnotation,
        redoAnnotation,
        invalidatePages,
        preserveNextSourceReloadVisibleContent,
    } = usePdfViewerCoreController({
        appAnnotationHistory,
        setUndoPdfjsAnnotationHandler,
        setRedoPdfjsAnnotationHandler,
        setPageRenderStallRecoveryHandler: handler => {
            pageRenderStallRecoveryHandler = handler;
        },
        viewerContainer,
        src,
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
        onDocumentLoadStateChange,
        emit,
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
        isViewerPanDragModeActive,
        cancelPendingSearchScroll,
        handleDragStart,
        handleDragMove,
        stopDrag,
        handleViewerMouseUpAnnotation: () => highlightComposable.handleViewerMouseUp(),
        handleViewerClickAnnotation: (event) => commentCrud.handleAnnotationCommentClick(event),
        handleViewerDblClickAnnotation: (event) => commentCrud.handleAnnotationEditorDblClick(event),
        handleViewerContextMenuAnnotation: (event) => commentCrud.handleAnnotationCommentContextMenu(event),
    });
    const {
        visibleMarkersByPage,
        visibleLinksByPage,
        shouldShowPageSkeleton,
        markPageRendered: markDelayedSkeletonPageRendered,
    } = usePdfRenderViewModel({
        src,
        isLoading,
        pdfDocument,
        viewerContainer,
        isVisualReloadTransitionActive,
        suppressLoadingOverlay,
        skeletonContentInsets,
        pagesToRender,
        isPageBuffered,
        isPageRenderedForClass,
        shouldShowSkeleton,
        visibleRange,
        currentPage: viewerCurrentPage,
        zoom,
        zoomMode,
        fitMode,
        effectiveScale,
        continuousScroll,
        numPages,
        markersByPage,
        linksByPage,
        renderVisiblePages,
        runGuardedTask,
    });
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
        cancelPendingSearchScroll,
        annotationRuntime,
        appAnnotationHistory,
        captureViewerScrollSnapshot,
        restoreViewerScrollSnapshot,
        applyFitWidthToCurrentPage,
        waitForViewerLoadSettled,
        preserveNextSourceReloadVisibleContent,
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
        invertColors,
        viewerClass,
        containerStyle,
        pagesToRender,
        shouldShowPageSkeleton,
        isSpreadSingle,
        isPageBuffered,
        isPageRenderedForClass,
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
        handleViewerContainerRef,
        pdfViewerPublicApi,
    };
}
