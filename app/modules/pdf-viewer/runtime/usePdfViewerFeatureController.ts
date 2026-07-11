import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type { GenericL10n } from 'pdfjs-dist/web/pdf_viewer.mjs';
import type { IPageRenderStallPayload } from '@app/modules/pdf-viewer/runtime/rendering/usePdfPageRenderer';
import { usePdfRenderViewModel } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRenderViewModel';
import { shouldShowPdfNavigationSkeleton } from '@app/modules/pdf-viewer/runtime/rendering/pdf-navigation-skeleton-eligibility/shouldShowPdfNavigationSkeleton';
import { createPdfPageSlotRegistry } from '@app/modules/pdf-viewer/runtime/page-slots/pdfPageSlotRegistry';
import { injectDocumentViewerChassisAuthority } from '@app/utils/document-viewer/chassis/documentViewerChassisAuthority';
import { createPdfPageSource } from '@app/utils/document-viewer/source/createPdfPageSource';
import { usePdfViewerRenderingRuntime } from '@app/modules/pdf-viewer/runtime/rendering/usePdfViewerRenderingRuntime';
import { usePdfAppAnnotationHistory } from '@app/modules/pdf-viewer/runtime/annotations/usePdfAppAnnotationHistory';
import { usePdfViewerRuntime } from '@app/modules/pdf-viewer/runtime/usePdfViewerRuntime';
import { usePdfViewerTransactionController } from '@app/modules/pdf-viewer/runtime/transactions/usePdfViewerTransactionController';
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
import {
    shouldDeferPdfDprRerenderForResize,
    usePdfViewerOutputScale,
} from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerOutputScale';
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
import { PDF_RERENDER_SOURCE } from '@app/modules/pdf-viewer/runtime/rerender-protocol/pdfRerenderProtocol';
import { usePdfViewerSelectionToolState } from '@app/modules/pdf-viewer/tools/public';
import { summarizeViewerMetrics } from '@app/modules/pdf-viewer/engine/pdf-viewer-metrics/summarizeViewerMetrics';
import { isStandaloneSpreadPage } from '@app/utils/pdfViewMode';
import { createPageNavigationRequest } from '@app/modules/pdf-viewer/engine/viewport/createPageNavigationRequest';
import type {
    IAnnotationModifiedPayload,
    ILinkAnnotation,
} from '@app/types/annotations';
import type { IPageRange } from '@app/types/pdfUi';
import { runGuardedTask } from '@app/utils/asyncGuard';
import {createEmptyPdfjsAnnotationEditorState} from '@app/modules/pdf-viewer/runtime/annotations/pdfjsAnnotationState';
import type { IPdfjsAnnotationEditorState } from '@app/modules/pdf-viewer/runtime/annotations/pdfjsAnnotationState';

let nextPdfPageSlotOwnerId = 0;

export const usePdfViewerFeatureController = (props: IPdfViewerProps, emit: IPdfViewerEmit) => {
    const chassisAuthority = injectDocumentViewerChassisAuthority();
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
    const pdfjsAnnotationEditorState = ref<IPdfjsAnnotationEditorState>(createEmptyPdfjsAnnotationEditorState());
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
        viewportWritePort: chassisAuthority?.viewportWritePort,
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
        getVisiblePageRange,
        scrollToPage: scrollToPageInternal,
        updateCurrentPage,
        updateVisibleRange,
        setPageLayoutMetrics,
    } = viewerRuntime.scroll;
    const {
        containerStyle: scaleContainerStyle,
        scaledMargin,
        computeFitWidthScale,
        clearPreviewFitScale,
        effectiveScale,
        layoutScale,
        fitWidthScale,
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
        clearAnnotationProjection,
        activeCommentStableKey,
        managedEmbeddedPdfShapes,
        managedEmbeddedAnnotationIds,
        renderHiddenEmbeddedAnnotationIds,
        highlightComposable,
        commentCrud,
        markersByPage,
        linksByPage,
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
    const userViewportInteractionEpoch = ref(0);
    const documentLoadToken = ref(0);
    let transactionController: ReturnType<typeof usePdfViewerTransactionController> | null = null;
    const renderSession = chassisAuthority?.renderCoordinator.createSession(
        `pdf-feature:${String(++nextPdfPageSlotOwnerId)}`,
    ) ?? null;
    const pageSlots = renderSession?.pageSlots ?? createPdfPageSlotRegistry();
    onScopeDispose(() => renderSession?.dispose());
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
        releaseUnmountedPage,
        isPageFreshlyRenderedForNavigation,
        isPageRenderedForClass,
    } = usePdfViewerRenderingRuntime({
        viewerContainer,
        document: pdfDocumentResult,
        currentPage: viewerCurrentPage,
        isActive,
        effectiveScale,
        outputScale,
        rasterDisplayProfile,
        bufferPages,
        showAnnotations,
        hiddenAnnotationIds: renderHiddenEmbeddedAnnotationIds,
        canvasHiddenAnnotationIds,
        managedAnnotationIds: managedEmbeddedAnnotationIds,
        annotationUiManager,
        annotationL10n,
        replaceAnnotationUiManager: (manager) => {
            if (annotationUiManager.value === manager) {
                annotations.editor.initAnnotationEditor();
            }
        },
        scrollToPage: (pageNumber, options) => singlePageScroll.scrollToPage(pageNumber, options),
        suppressSnap: () => undefined,
        beginSearchNavigation: (pageNumber) => {
            markUserViewportInteraction();
            singlePageScroll.beginSearchNavigation(pageNumber);
        },
        revealSearchNavigationTarget: (pageNumber, options) => singlePageScroll.revealSearchNavigationTarget(pageNumber, options),
        endSearchNavigation: () => singlePageScroll.endSearchNavigation(),
        beginSearchTransaction: (pageNumber, options) => (
            transactionController?.beginTransaction({
                kind: 'search',
                source: 'search-navigation',
                page: pageNumber,
                anchor: options?.markerRect ? 'marker' : 'top',
                markerRect: options?.markerRect ?? null,
            })?.id ?? null
        ),
        isSearchTransactionCurrent: transactionId => (
            transactionController?.isTransactionCurrent(transactionId) ?? true
        ),
        settleSearchTransaction: transactionId => {
            transactionController?.advanceTransaction(transactionId, 'settled');
        },
        cancelSearchTransaction: transactionId => {
            transactionController?.cancelActiveTransaction({
                reason: 'superseded',
                cancelInFlightRenders: false,
                bumpRenderVersion: false,
                preserveVisualContent: true,
            }, transactionId);
        },
        searchPageMatches,
        currentSearchMatch,
        currentSearchMatchNavigationId,
        workingCopyPath,
        documentRevisionToken,
        pageSlots,
        viewportWritePort: viewerRuntime.scroll.viewportWritePort,
        onRenderStall: relayPageRenderStall,
        isVisibleRenderRangeCurrent: range => isVisibleRenderRangeCurrent(range),
        onPageCanvasMounted: pageNumber => {
            handlePageCanvasMounted(pageNumber);
        },
        onPageRendered: pageNumber => {
            handlePageRendered(pageNumber);
        },
        onAnnotationLayersRendered: pageNumber => applyEditedTextMarkupColorsForRenderedPage(pageNumber),
        onRenderedPageStateChanged: handleRenderedPageStateChanged,
        renderedPageStateVersion,
    });
    annotationRuntime.attachRenderingPort({
        renderVisiblePages,
        renderAnnotationEditorLayerForPage,
        isPageRendered,
        invalidatePages: invalidateRenderedPages,
        hideManagedAnnotationEditors,
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
        if (shouldDeferPdfDprRerenderForResize(isResizing.value)) {
            BrowserLogger.diagnostic('pdf-nav', '[dpr-change] deferred to active layout-resize settle', {
                previousScale,
                nextScale,
            });
            return;
        }

        runGuardedTask(
            () => reRenderAllVisiblePages(() => visibleRange.value, {
                preserveExistingPages: true,
                rerenderSource: PDF_RERENDER_SOURCE.DprChange,
                renderBufferOverride: 0,
            }),
            {
                category: 'user-visible-operation',
                scope: 'pdf-viewer',
                message: 'Failed to re-render PDF pages after display scale change',
            },
        );
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
        commitVisibleRange: (range, options) => transactionController?.commitVisibleRange(range, options),
        renderVisiblePages,
        ensurePageMetricsInRange: pdfDocumentResult.ensurePageMetricsInRange,
        isPageFreshlyRenderedForNavigation,
        visibleRange,
        emitCurrentPage: viewerEvents.updateCurrentPage,
        emitNavigationFeedbackPage: viewerEvents.updateNavigationFeedbackPage,
        viewportWritePort: viewerRuntime.scroll.viewportWritePort,
        getPageLayoutMetrics: viewerRuntime.scroll.getPageLayoutMetrics,
        bindCurrentPageProjection: viewerRuntime.scroll.bindCurrentPageProjection,
        getDocumentRevision: () => pdfDocumentResult.getRenderVersion() + 1,
        getGeometryRevision: () => pageMetricsVersion.value + 1,
        pageSlots,
        requestedCurrentPage,
        cancelPendingSearchScroll,
    });
    let anchoredZoomAlreadySubmitted: number | null = null;
    watch(zoom, (value) => {
        if (
            anchoredZoomAlreadySubmitted !== null
            && Math.abs(anchoredZoomAlreadySubmitted - value) < 0.000_001
        ) {
            anchoredZoomAlreadySubmitted = null;
            return;
        }
        anchoredZoomAlreadySubmitted = null;
        void singlePageScroll.submitViewportStateIntent('zoom', {zoom: value});
    });
    watch(fitMode, () => { void singlePageScroll.submitViewportStateIntent('fit'); });
    watch(viewMode, value => { void singlePageScroll.submitViewportStateIntent('view-mode', {viewMode: value}); });
    watch(outputScale, value => { void singlePageScroll.submitViewportStateIntent('dpr', {dpr: value}); });
    watch(isActive, (active) => {
        if (!active) {
            singlePageScroll.viewportAuthority.suspend();
            return;
        }
        void singlePageScroll.submitViewportStateIntent('activation');
    });
    transactionController = usePdfViewerTransactionController({
        navigationState: singlePageScroll.navigationState,
        currentPage: viewerCurrentPage,
        visibleRange,
        numPages,
        viewMode,
        pdfDocument,
        userViewportInteractionEpoch,
        getDocumentLoadToken: () => documentLoadToken.value,
        getDocumentVersion: pdfDocumentResult.getRenderVersion,
        executeCancellationEffects: (cancellation) => {
            if (cancellation.cancelInFlightRenders || cancellation.bumpRenderVersion) {
                void cancelInFlightRenders();
            }
        },
    });
    getNavigationRenderTargetPage = () => (
        transactionController?.targetPage.value ?? null
    );
    const { navigationAnchorPage } = singlePageScroll;

    function markUserViewportInteraction() {
        userViewportInteractionEpoch.value += 1;
        singlePageScroll.cancelProgrammaticNavigation();
    }

    function handleLinkDestination(dest: NonNullable<ILinkAnnotation['dest']>) {
        const request = createPageNavigationRequest(viewerCurrentPage.value, 'bookmark');
        request.target = {
            kind: 'named-dest',
            destination: dest,
        };
        request.alignment = 'page-top';
        request.readiness = 'page-canvas';
        singlePageScroll.submitNavigationRequest(request);
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
        viewportWritePort: viewerRuntime.scroll.viewportWritePort,
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
        virtualPageSegments,
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
        effectiveScale: layoutScale,
        scaledMargin,
        visibleRange,
        navigationAnchorPage,
        resizeTransitionAnchorPage,
        zoomVirtualizationFreeze,
        scaleContainerStyle,
        selectionMarkupStyle,
        viewportWritePort: viewerRuntime.scroll.viewportWritePort,
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
        singlePageScroll: {
            suppressSnapFor: () => undefined,
            handleWheel: singlePageScroll.handleWheel,
            handleScroll: singlePageScroll.handleScroll,
            cancelProgrammaticNavigation: singlePageScroll.cancelProgrammaticNavigation,
            isProgrammaticNavigationActive: singlePageScroll.isProgrammaticNavigationActive,
            shouldCancelProgrammaticNavigationForViewportScroll:
                singlePageScroll.shouldCancelProgrammaticNavigationForViewportScroll,
        },
        cancelPendingSearchScroll,
        markUserViewportInteraction,
        submitZoomIntent: (intent) => {
            anchoredZoomAlreadySubmitted = intent.zoom;
            void singlePageScroll.submitViewportStateIntent('zoom', {
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
    watch(
        wheelZoomSnapSuppressed,
        value => {
            zoomSnapSuppressedForClass.value = value;
        },
        { immediate: true },
    );
    usePdfViewerSourceChangeLifecycle({
        src,
        documentKey: computed(() => workingCopyPath.value ?? null),
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
        viewportWritePort: viewerRuntime.scroll.viewportWritePort,
        submitResizeIntent: anchor => {
            void singlePageScroll.submitViewportStateIntent(
                'resize',
                anchor ? {anchor} : {},
            );
        },
        captureViewportAnchor: singlePageScroll.captureCurrentSemanticAnchor,
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
        clearAnnotationProjection,
        activeCommentStableKey,
        pdfDocumentResult,
        annotations,
        currentPage: viewerCurrentPage,
        currentPageAuthority: singlePageScroll.currentPageAuthority,
        pagedNavigationTargetPage: singlePageScroll.pagedNavigationTargetPage,
        navigationAnchorPage,
        visibleRange,
        commitVisibleRange: range => transactionController?.commitVisibleRange(range),
        effectiveScale,
        basePageWidth,
        basePageHeight,
        computeFitWidthScale,
        clearPreviewFitScale,
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
        getVisiblePageRange,
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
        transactionController: transactionController ?? undefined,
        emitLoadError: viewerEvents.loadError,
        onDocumentLoadStateChange: (payload) => {
            if (payload.phase === 'started') {
                documentLoadToken.value = payload.token;
            }
            onDocumentLoadStateChange(payload);
        },
        emit,
    });
    pageRenderStallRecoveryHandler = runtimeLifecycle.handlePageRenderStall;

    function undoAnnotation() {
        return appAnnotationHistory.undo();
    }

    function redoAnnotation() {
        return appAnnotationHistory.redo();
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
    function hasMountedPageCanvas(pageNumber: number) {
        return Boolean(
            viewerContainer.value?.querySelector(
                `.page_container[data-page="${pageNumber}"] .page_canvas canvas`,
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
        return isPageRenderedForClass(pageNumber);
    }
    const shouldShowNavigationSkeleton = (pageNumber: number) => shouldShowPdfNavigationSkeleton({
        pageNumber,
        navigationAnchorPage: navigationSkeletonAnchorPage.value,
        totalPages: numPages.value,
        viewMode: viewMode.value,
        isPageRendered: isPageVisuallyReady,
        shouldShowSkeleton,
    });
    function handlePageContainerMounted(pageNumber: number) {
        pageSlots.markMounted(pageNumber);
    }
    function handlePageContainerUnmounted(pageNumber: number) {
        pageSlots.markUnmounted(pageNumber);
        releaseUnmountedPage(pageNumber);
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
        skeletonContentInsets,
        pagesToRender,
        isPageBuffered,
        isPageRenderedForClass,
        isPageRendering,
        hasMountedPageCanvas,
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
    watch([
        pdfDocument,
        src,
        workingCopyPath,
    ], ([
        documentProxy,
        sourceRef,
        workingCopyRef,
    ], _previous, onCleanup) => {
        if (!chassisAuthority || !documentProxy) {
            if (chassisAuthority?.source.value?.kind === 'pdf') {
                chassisAuthority.bindSource(null);
            }
            return;
        }
        const pageSource = createPdfPageSource({
            documentRef: workingCopyRef ?? (typeof sourceRef === 'string' ? sourceRef : 'memory://pdf'),
            pdfDocument: documentProxy,
            async renderPage(request) {
                request.signal.throwIfAborted();
                const page = await documentProxy.getPage(request.pageNumber);
                const baseViewport = page.getViewport({scale: 1});
                const scale = request.widthPx / Math.max(1, baseViewport.width);
                const viewport = page.getViewport({scale});
                const canvas = window.document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(viewport.width));
                canvas.height = Math.max(1, Math.round(viewport.height));
                const canvasContext = canvas.getContext('2d');
                if (!canvasContext) {
                    throw new Error('PDF page-source canvas context is unavailable');
                }
                const renderTask = page.render({
                    canvas,
                    canvasContext,
                    viewport,
                });
                const cancelRender = () => renderTask.cancel();
                request.signal.addEventListener('abort', cancelRender, {once: true});
                try {
                    await renderTask.promise;
                    request.signal.throwIfAborted();
                } finally {
                    request.signal.removeEventListener('abort', cancelRender);
                }
                const bytes = canvas.width * canvas.height * 4;
                const budgetLease = chassisAuthority.surfaceBudget.reserve({
                    scopeId: `pdf-page-source:${String(workingCopyRef ?? sourceRef ?? 'memory')}`,
                    category: 'pdf-page-canvas',
                    bytes,
                    priority: request.priority === 'navigation' ? 100 : 50,
                });
                let released = false;
                return {
                    widthPx: canvas.width,
                    heightPx: canvas.height,
                    bytes,
                    surface: canvas,
                    release() {
                        if (!released) {
                            released = true;
                            budgetLease.release();
                            canvas.width = 0;
                            canvas.height = 0;
                        }
                    },
                };
            },
        });
        chassisAuthority.bindSource(pageSource);
        onCleanup(() => {
            pageSource.dispose();
            if (chassisAuthority.source.value === pageSource) {
                chassisAuthority.bindSource(null);
            }
        });
    }, {immediate: true});
    const {
        applyFitWidthToCurrentPage,
        materializePdfJsDocumentForInternalUse,
        runSaveTransaction,
        saveViewerDocument,
        renderLoadedPdfPagesForBrowserPrint,
    } = usePdfViewerExposeControllers({
        viewerContainer,
        currentPage: viewerCurrentPage,
        pdfDocument,
        documentRevisionToken,
        annotationUiManager,
        annotationRuntime,
        isLoading,
        continuousScroll,
        fitMode,
        zoomMode,
        zoom,
        effectiveScale,
        fitWidthScale,
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
        applyFitWidthToCurrentPage,
        waitForViewerLoadSettled,
        renderVisiblePages,
        preserveNextSourceReloadVisibleContent,
        getPagePreview,
        runSaveTransaction,
        saveViewerDocument,
        materializePdfJsDocumentForInternalUse,
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
        virtualPageSegments,
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
        handlePageContainerUnmounted,
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
