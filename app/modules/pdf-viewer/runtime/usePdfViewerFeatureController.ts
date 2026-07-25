import { injectDocumentViewerChassisAuthority } from '@app/utils/document-viewer/chassis/documentViewerChassisAuthority';
import { getPerformanceProfile } from '@app/utils/performanceProfile';
import { resolvePdfRenderPerformancePolicy } from '@app/modules/pdf-viewer/engine/pdf-render-performance/resolvePdfRenderPerformancePolicy';
import { summarizeViewerMetrics } from '@app/modules/pdf-viewer/engine/pdf-viewer-metrics/summarizeViewerMetrics';
import { isStandaloneSpreadPage } from '@app/utils/pdfViewMode';
import { shouldShowPdfNavigationSkeleton } from '@app/modules/pdf-viewer/runtime/rendering/pdf-navigation-skeleton-eligibility/shouldShowPdfNavigationSkeleton';
import { usePdfRenderViewModel } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRenderViewModel';
import { createPdfDocumentSession } from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';
import {
    createPdfViewportSession,
    type TPdfViewportSession,
} from '@app/modules/pdf-viewer/runtime/sessions/createPdfViewportSession';
import {
    createPdfRenderingSession,
    type TPdfRenderingSession,
} from '@app/modules/pdf-viewer/runtime/sessions/createPdfRenderingSession';
import {
    createPdfAnnotationSession,
    type TPdfAnnotationSession,
} from '@app/modules/pdf-viewer/runtime/sessions/createPdfAnnotationSession';
import { usePdfViewerPublicApiController } from '@app/modules/pdf-viewer/runtime/usePdfViewerPublicApiController';
import { usePdfViewerFitWidthController } from '@app/modules/pdf-viewer/runtime/viewport/usePdfViewerFitWidthController';
import type { IBrowserPrintDocument } from '@app/utils/pdfPrintShared';
import { usePdfViewerNavigationDiagnostics } from '@app/modules/pdf-viewer/runtime/lifecycle/usePdfViewerNavigationDiagnostics';
import { usePdfViewerMouseInteractions } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerMouseInteractions';
import { usePdfViewerWheelZoom } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerWheelZoom';
import { usePdfViewerOutputScale } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerOutputScale';
import { usePdfCropSelection } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfCropSelection';
import { usePdfImagePlacement } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfImagePlacement';
import { usePdfRegionSnip } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfRegionSnip';
import { usePdfViewerSelectionToolState } from '@app/modules/pdf-viewer/tools/public';
import { createPdfViewerEventAdapter } from '@app/modules/pdf-viewer/runtime/contracts/createPdfViewerEventAdapter';
import { createPdfViewportWritePort } from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportWritePort';
import { usePdfViewerPropModel } from '@app/modules/pdf-viewer/runtime/contracts/usePdfViewerPropModel';
import type {
    IPdfViewerProps,
    IPdfViewerEmit,
} from '@app/modules/pdf-viewer/runtime/contracts/pdfViewerComponent.types';

/**
 * Composition root for the PDF viewer feature.
 *
 * It constructs the four sessions in topological order and adapts their read
 * models and commands to `PdfViewer.vue` and the exposed viewer API. It owns
 * no lifecycle of its own.
 */
export const usePdfViewerFeatureController = (props: IPdfViewerProps, emit: IPdfViewerEmit) => {
    const chassisAuthority = injectDocumentViewerChassisAuthority();
    const openSurfaceRenderOwner = chassisAuthority?.openSurface.claimRenderOwner();
    const {
        src,
        reloadSrc,
        sourcePdfData,
        rasterDisplayProfile,
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
        documentRevisionToken,
        continuousScroll,
        isActive,
        authorName,
    } = usePdfViewerPropModel(props);
    const { t } = useTypedI18n();
    const viewerEvents = createPdfViewerEventAdapter(emit);
    const viewerHost = ref<HTMLElement | null>(null);
    const viewerContainer = ref<HTMLElement | null>(null);
    const summarizeViewerStateForLog = () => summarizeViewerMetrics(viewerContainer.value);
    const performanceProfile = getPerformanceProfile();
    const performancePolicy = resolvePdfRenderPerformancePolicy(performanceProfile);
    const outputScale = usePdfViewerOutputScale(performancePolicy);
    const viewportWritePort = chassisAuthority?.viewportWritePort ?? createPdfViewportWritePort();
    const regionSnip = usePdfRegionSnip({ viewerContainer });
    const cropSelection = usePdfCropSelection({ viewerContainer });
    const viewportSessionRef = shallowRef<TPdfViewportSession | null>(null);
    const renderingSessionRef = shallowRef<TPdfRenderingSession | null>(null);
    const annotationSessionRef = shallowRef<TPdfAnnotationSession | null>(null);
    const viewerCurrentPage = computed(() => viewportSessionRef.value?.currentPage.value ?? 1);
    const viewerEffectiveScale = computed(() => viewportSessionRef.value?.scale.effectiveScale.value ?? 1);

    const documentSession = createPdfDocumentSession({
        chassisAuthority,
        openSurfaceDocumentId: () => String(props.originalPath ?? workingCopyPath.value ?? src.value ?? 'pdf-open'),
        emitInitialVisualPending: viewerEvents.initialVisualPending,
        src,
        reloadSrc,
        documentLifecycleKey: computed(() => props.originalPath ?? null),
        documentRevisionToken,
        originalDocumentId: computed(() => props.originalPath ?? null),
        currentPage: viewerCurrentPage,
        pageSourceDocumentRef: workingCopyPath,
        isActive,
        isAnySaving,
        emitDocument: document => emit('update:document', document),
        emitTotalPages: total => emit('update:totalPages', total),
        emitLoading: (loading) => {
            emit('update:loading', loading);
            emit('loading', loading);
        },
        emitLoadError: viewerEvents.loadError,
        emitRasterScheduler: scheduler => emit('update:rasterScheduler', scheduler),
    });

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
        numPages: documentSession.numPages,
        effectiveScale: viewerEffectiveScale,
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
        viewportWritePort,
    });

    const isPlacingComment = computed(
        () => annotationSessionRef.value?.highlightComposable.isPlacingComment.value ?? false,
    );
    const viewportSession = createPdfViewportSession({
        document: documentSession,
        chassisAuthority,
        performancePolicy,
        maxBufferCanvasPixels: performanceProfile.maxBufferCanvasPixels,
        settledMaxCanvasPixels: performanceProfile.settledMaxCanvasPixels,
        viewerContainer,
        viewportWritePort,
        zoom,
        zoomMode,
        fitMode,
        viewMode,
        continuousScroll,
        bufferPages,
        isActive,
        isResizing,
        requestedCurrentPage,
        outputScale,
        selectionMarkupStyle,
        classState: {
            isAnySaving,
            isDragging,
            isViewerPanDragModeActive: computed(() => isViewerPanDragModeActive.value && !isPlacingComment.value),
            isPlacingComment,
            isSelectionMarkupToolActive: computed(() => isSelectionMarkupToolActive.value && !isPlacingComment.value),
            isTextSelectionModeActive: computed(() => isTextSelectionModeActive.value && !isPlacingComment.value),
            fitMode,
            zoomMode,
            resizeTransitionVisible: computed(
                () => viewportSessionRef.value?.resizeTransitionVisible.value ?? false,
            ),
            zoomSnapSuppressed: computed(
                () => viewportSessionRef.value?.zoomSnapSuppressedForClass.value ?? false,
            ),
        },
        emitCurrentPage: viewerEvents.updateCurrentPage,
        emitNavigationFeedbackPage: viewerEvents.updateNavigationFeedbackPage,
        emitZoom: value => emit('update:zoom', value),
        emitEffectiveZoom: viewerEvents.updateEffectiveZoom,
        summarizeViewerStateForLog,
        clearPendingImagePlacement,
    });
    viewportSessionRef.value = viewportSession;

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
        isLoading: documentSession.isLoading,
        zoom,
        zoomMode,
        effectiveScale: viewportSession.scale.effectiveScale,
        currentPage: viewportSession.currentPage,
        visibleRange: viewportSession.visibleRange,
        virtualizedContinuousMode: viewportSession.viewModel.virtualizedContinuousMode,
        virtualWindowStart: viewportSession.viewModel.virtualWindowStart,
        virtualWindowEnd: viewportSession.viewModel.virtualWindowEnd,
        zoomVirtualizationFreeze: viewportSession.zoomVirtualizationFreeze,
        singlePageScroll: {
            suppressSnapFor: () => undefined,
            handleWheel: viewportSession.singlePageScroll.handleWheel,
            handleScroll: viewportSession.singlePageScroll.handleScroll,
            consumeAuthorityScroll: viewportSession.singlePageScroll.consumeAuthorityScroll,
            cancelProgrammaticNavigation: viewportSession.singlePageScroll.cancelProgrammaticNavigation,
            isProgrammaticNavigationActive: viewportSession.singlePageScroll.isProgrammaticNavigationActive,
            shouldCancelProgrammaticNavigationForViewportScroll:
                viewportSession.singlePageScroll.shouldCancelProgrammaticNavigationForViewportScroll,
        },
        cancelPendingSearchScroll: () => renderingSessionRef.value?.cancelPendingSearchScroll(),
        markUserViewportInteraction: viewportSession.markUserViewportInteraction,
        captureZoomVisualSnapshots: () => renderingSessionRef.value?.captureZoomVisualSnapshots(),
        submitZoomIntent: (intent) => {
            viewportSession.markAnchoredZoomSubmitted(intent.zoom);
            void viewportSession.singlePageScroll.submitViewportStateIntent('zoom', {
                zoom: intent.zoom,
                viewportPoint: {
                    x: intent.x,
                    y: intent.y,
                },
            });
        },
        isSnipActive: () => regionSnip.isActive.value || cropSelection.isSelecting.value,
        emit,
    });
    watch(wheelZoomSnapSuppressed, (value) => {
        viewportSession.zoomSnapSuppressedForClass.value = value;
    }, { immediate: true });

    let markDelayedSkeletonPageRendered = (_pageNumber: number) => {};
    const renderingSession = createPdfRenderingSession({
        document: documentSession,
        viewport: viewportSession,
        chassisAuthority,
        openSurfaceRenderOwner,
        performancePolicy,
        viewerContainer,
        isActive,
        isResizing,
        isAnySaving,
        zoom,
        zoomMode,
        fitMode,
        viewMode,
        continuousScroll,
        outputScale,
        rasterDisplayProfile,
        bufferPages,
        showAnnotations,
        searchPageMatches,
        currentSearchMatch,
        currentSearchMatchNavigationId,
        workingCopyPath,
        documentRevisionToken,
        maxBufferCanvasPixels: performanceProfile.maxBufferCanvasPixels,
        consumeZoomViewportAnchor,
        isZoomInteractionLocked,
        setZoomRerenderBusy,
        markDelayedSkeletonPageRendered: pageNumber => markDelayedSkeletonPageRendered(pageNumber),
        emitInitialVisualReady: viewerEvents.initialVisualReady,
        emitLoadError: viewerEvents.loadError,
    });
    renderingSessionRef.value = renderingSession;

    const annotationSession = createPdfAnnotationSession({
        document: documentSession,
        viewport: viewportSession,
        rendering: renderingSession,
        viewerContainer,
        originalPath: computed(() => props.originalPath ?? null),
        src,
        sourcePdfData,
        workingCopyPath,
        documentRevisionToken,
        isAnySaving,
        isActive,
        bufferPages,
        annotationTool,
        annotationCursorMode,
        annotationKeepActive,
        annotationSettings,
        authorName,
        stopDrag: () => stopDrag(),
        clearPendingImagePlacement,
        emitAnnotationModified: payload => viewerEvents.annotationModified(payload),
        emitAnnotationState: viewerEvents.annotationState,
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
    annotationSessionRef.value = annotationSession;

    const renderViewModel = usePdfRenderViewModel({
        src,
        isLoading: documentSession.isLoading,
        pdfDocument: documentSession.pdfDocument,
        getPage: documentSession.getPage,
        viewerContainer,
        isVisualReloadTransitionActive: viewportSession.reloadTransition.isVisualReloadTransitionActive,
        suppressLoadingOverlay,
        skeletonContentInsets: viewportSession.skeletonInsets.skeletonContentInsets,
        pagesToRender: viewportSession.viewModel.pagesToRender,
        isPageBuffered: viewportSession.viewModel.isPageBuffered,
        isPageRenderedForClass: renderingSession.isPageRenderedForClass,
        isPageRendering: renderingSession.isPageRendering,
        isPageRenderFailed: renderingSession.isPageRenderFailed,
        shouldShowSkeleton: pageNumber => shouldShowPdfNavigationSkeleton({
            pageNumber,
            navigationAnchorPage: viewportSession.singlePageScroll.navigationAnchorPage.value
                ?? viewportSession.currentPage.value,
            totalPages: documentSession.numPages.value,
            viewMode: viewMode.value,
            isPageRendered: renderingSession.isPageVisualReady,
            shouldShowSkeleton: isPageNearVisibleAndUnrendered,
        }),
        visibleRange: viewportSession.visibleRange,
        currentPage: viewportSession.currentPage,
        zoom,
        zoomMode,
        fitMode,
        effectiveScale: viewportSession.scale.effectiveScale,
        continuousScroll,
        numPages: documentSession.numPages,
        markersByPage: annotationSession.markersByPage,
        linksByPage: annotationSession.linksByPage,
    });
    markDelayedSkeletonPageRendered = renderViewModel.markPageRendered;

    const SKELETON_BUFFER = 3;
    function isPageNearVisibleAndUnrendered(pageNumber: number) {
        const start = Math.max(1, viewportSession.visibleRange.value.start - SKELETON_BUFFER);
        const end = Math.min(documentSession.numPages.value, viewportSession.visibleRange.value.end + SKELETON_BUFFER);
        return pageNumber >= start
            && pageNumber <= end
            && !renderingSession.isPageRendered(pageNumber);
    }

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
        isCommentPlacementActive: () => isPlacingComment.value,
        isViewerPanDragModeActive,
        markUserViewportInteraction: viewportSession.markUserViewportInteraction,
        cancelPendingSearchScroll: () => renderingSession.cancelPendingSearchScroll(),
        handleDragStart: event => startDrag(event, viewerContainer.value),
        handleDragMove: event => onDrag(event, viewerContainer.value),
        stopDrag,
        handleViewerMouseUpAnnotation: () => annotationSession.highlightComposable.handleViewerMouseUp(),
        handleViewerClickAnnotation: event => annotationSession.commentCrud.handleAnnotationCommentClick(event),
        handleViewerDblClickAnnotation: event => annotationSession.commentCrud.handleAnnotationEditorDblClick(event),
        handleViewerContextMenuAnnotation: event => annotationSession.commentCrud.handleAnnotationCommentContextMenu(event),
    });

    usePdfViewerNavigationDiagnostics({
        currentPage: viewportSession.currentPage,
        visibleRange: viewportSession.visibleRange,
        isLoading: documentSession.isLoading,
        continuousScroll,
        fitMode,
        viewMode,
        zoom,
        navigationAnchorWindow: viewportSession.viewModel.navigationAnchorWindow,
        virtualizedContinuousMode: viewportSession.viewModel.virtualizedContinuousMode,
        virtualWindowStart: viewportSession.viewModel.virtualWindowStart,
        virtualWindowEnd: viewportSession.viewModel.virtualWindowEnd,
        searchNavigationTargetPage: viewportSession.singlePageScroll.searchNavigationTargetPage,
        searchNavigationState: viewportSession.singlePageScroll.searchNavigationState,
        getRasterSchedulerSnapshot: renderingSession.getRasterSchedulerSnapshot,
        summarizeViewerStateForLog,
    });

    const { applyFitWidthToCurrentPage } = usePdfViewerFitWidthController({
        viewerContainer,
        currentPage: viewportSession.currentPage,
        pdfDocument: documentSession.pdfDocument,
        isLoading: documentSession.isLoading,
        continuousScroll,
        fitMode,
        zoomMode,
        zoom,
        effectiveScale: viewportSession.scale.effectiveScale,
        fitWidthScale: viewportSession.scale.fitWidthScale,
        viewMode,
        numPages: documentSession.numPages,
        pageMetricsVersion: documentSession.pageMetricsVersion,
        visibleRange: viewportSession.visibleRange,
        syncHorizontalScrollForZoomMode: viewportSession.viewModel.syncHorizontalScrollForZoomMode,
        computeFitWidthScale: viewportSession.scale.computeFitWidthScale,
        isFitWidthScaleCurrent: viewportSession.scale.isFitWidthScaleCurrent,
        cancelInFlightRenders: renderingSession.cancelInFlightRenders,
        reRenderAllVisiblePages: renderingSession.reRenderAllVisiblePages,
        emitZoomMode: viewerEvents.updateZoomMode,
    });
    async function renderLoadedPdfPagesForBrowserPrint(
        targetDocument: IBrowserPrintDocument,
        pageNumbers: number[],
        renderOptions?: { signal?: AbortSignal },
    ) {
        const pdfDocument = documentSession.pdfDocument.value;
        if (!pdfDocument) {
            throw new Error('Missing loaded PDF document');
        }
        const { renderPdfDocumentPagesForBrowserPrint } = await import('@app/utils/pdfPrint');
        await renderPdfDocumentPagesForBrowserPrint(targetDocument, pdfDocument, pageNumbers, renderOptions);
    }

    const pdfViewerPublicApi = usePdfViewerPublicApiController({
        viewerContainer,
        documentSession,
        viewportSession,
        getUserViewportInteractionEpoch: () => viewportSession.userViewportInteractionEpoch.value,
        cancelPendingSearchScroll: () => renderingSession.cancelPendingSearchScroll(),
        annotationSession,
        applyFitWidthToCurrentPage,
        waitForViewerLoadSettled: documentSession.waitForLoadSettled,
        renderVisiblePages: renderingSession.renderVisiblePages,
        preserveNextSourceReloadVisibleContent: viewportSession.preserveNextSourceReloadVisibleContent,
        renderLoadedPdfPagesForBrowserPrint,
        startImagePlacement,
        clearPendingImagePlacement,
        restorePendingImagePlacement,
        invalidatePages: renderingSession.invalidatePages,
        captureRegionToClipboard: regionSnip.startCaptureSession,
        isCapturingRegion: regionSnip.isActive,
        startCropSelection: cropSelection.startCropSelection,
        cancelCropSelection: cropSelection.cancelSelection,
        isCropSelecting: cropSelection.isSelecting,
        requestScrollToCurrentResult: renderingSession.requestScrollToCurrentResult,
    });

    return {
        t,
        viewerHost,
        viewerContainer,
        renderedPageStateVersion: readonly(renderingSession.renderedPageStateVersion),
        annotationUiManager: annotationSession.annotationUiManager,
        viewerClass: viewportSession.viewModel.viewerClass,
        containerStyle: viewportSession.viewModel.containerStyle,
        scaledMargin: viewportSession.scale.scaledMargin,
        openingVirtualExtentMinimumScrollHeight:
            viewportSession.openVirtualSurfaceGeometry.openingVirtualExtentMinimumScrollHeight,
        pagesToRender: viewportSession.viewModel.pagesToRender,
        virtualPageSegments: viewportSession.viewModel.virtualPageSegments,
        shouldShowPageSkeleton: renderViewModel.shouldShowPageSkeleton,
        isPageRenderFailed: renderingSession.isPageRenderFailed,
        isSpreadSingle: (page: number) => isStandaloneSpreadPage(page, viewMode.value, documentSession.numPages.value),
        isPageBuffered: viewportSession.viewModel.isPageBuffered,
        isPageRenderedForClass: renderingSession.isPageRenderedForClass,
        isPageVisualReadyForShapeOverlay: renderingSession.isPageVisualReady,
        getPagePlaceholderStyle: viewportSession.viewModel.getPagePlaceholderStyle,
        getExactPagePlaceholderStyle: viewportSession.openVirtualSurfaceGeometry.getExactPagePlaceholderStyle,
        topVirtualSpacerStyle: viewportSession.viewModel.topVirtualSpacerStyle,
        bottomVirtualSpacerStyle: viewportSession.openVirtualSurfaceGeometry.bottomVirtualSpacerStyle,
        pendingImagePlacement,
        isPendingImagePlacementFinalizing,
        handleViewportScroll: (event: Event) => {
            viewportSession.viewModel.syncHorizontalScrollForZoomMode();
            handleViewerScroll(event);
        },
        handleViewerWheel,
        handleViewerMouseDown,
        handleViewerMouseMove,
        handleViewerMouseUp,
        handleViewerMouseLeave,
        handleViewerClick,
        handleViewerDblClick,
        handleViewerContextMenu,
        handleSelectStart,
        handlePageContainerMounted: (pageNumber: number) => viewportSession.markPageMounted(pageNumber),
        handlePageContainerUnmounted: (pageNumber: number) => {
            viewportSession.markPageUnmounted(pageNumber);
            renderingSession.releaseUnmountedPage(pageNumber);
        },
        updatePendingImagePlacementRect,
        requestPendingImagePlacementFinalize,
        clearPendingImagePlacement,
        regionSnip,
        cropSelection,
        visibleMarkersByPage: renderViewModel.visibleMarkersByPage,
        visibleLinksByPage: renderViewModel.visibleLinksByPage,
        handleMarkerOpenNote: annotationSession.handleMarkerOpenNote,
        handleMarkerContextMenu: annotationSession.handleMarkerContextMenu,
        handleMarkerMove: annotationSession.handleMarkerMove,
        handleLinkDestination: viewportSession.handleLinkDestination,
        handleViewerContainerRef: viewportSession.handleViewerContainerRef,
        pdfViewerPublicApi,
    };
};
