import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type { GenericL10n } from 'pdfjs-dist/web/pdf_viewer.mjs';
import type { IPageRenderStallPayload } from '@app/modules/pdf-viewer/runtime/rendering/usePdfPageRenderer';
import type { IRenderVisiblePagesOptions } from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';
import { usePdfRenderViewModel } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRenderViewModel';
import { usePdfRenderDemandCoordinator } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRenderDemandCoordinator';
import { shouldShowPdfNavigationSkeleton } from '@app/modules/pdf-viewer/runtime/rendering/pdf-navigation-skeleton-eligibility/shouldShowPdfNavigationSkeleton';
import { createPdfPageSlotRegistry } from '@app/modules/pdf-viewer/runtime/page-slots/pdfPageSlotRegistry';
import { injectDocumentViewerChassisAuthority } from '@app/utils/document-viewer/chassis/documentViewerChassisAuthority';
import { hasCommittedDocumentOpeningLayout } from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';
import { createPdfPageSource } from '@app/utils/document-viewer/source/createPdfPageSource';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import { usePdfViewerRenderingRuntime } from '@app/modules/pdf-viewer/runtime/rendering/usePdfViewerRenderingRuntime';
import { usePdfAppAnnotationHistory } from '@app/modules/pdf-viewer/runtime/annotations/usePdfAppAnnotationHistory';
import { usePdfViewerRuntime } from '@app/modules/pdf-viewer/runtime/usePdfViewerRuntime';
import type { usePdfViewerTransactionController } from '@app/modules/pdf-viewer/runtime/transactions/usePdfViewerTransactionController';
import { usePdfViewerNavigationOrchestration } from '@app/modules/pdf-viewer/runtime/navigation/usePdfViewerNavigationOrchestration';
import { usePdfViewportViewModel } from '@app/modules/pdf-viewer/runtime/viewport/usePdfViewportViewModel';
import { usePdfOpenVirtualSurfaceGeometry } from '@app/modules/pdf-viewer/runtime/viewport/usePdfOpenVirtualSurfaceGeometry';
import { usePdfViewerViewportLifecycle } from '@app/modules/pdf-viewer/runtime/viewport/usePdfViewerViewportLifecycle';
import { usePdfViewerRuntimeLifecycle } from '@app/modules/pdf-viewer/runtime/lifecycle/usePdfViewerRuntimeLifecycle';
import { usePdfViewerExposeControllers } from '@app/modules/pdf-viewer/runtime/usePdfViewerExposeControllers';
import { usePdfViewerLoadLifecycleController } from '@app/modules/pdf-viewer/runtime/lifecycle/usePdfViewerLoadLifecycleController';
import { usePdfInitialCanvasCommitCoordinator } from '@app/modules/pdf-viewer/runtime/lifecycle/usePdfInitialCanvasCommitCoordinator';
import { commitPdfOpenSurfaceViewport } from '@app/modules/pdf-viewer/runtime/navigation/commitPdfOpenSurfaceViewport';
import { usePdfTrustedOpenGeometryLifecycle } from '@app/modules/pdf-viewer/runtime/lifecycle/usePdfTrustedOpenGeometryLifecycle';
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
import * as initialPageSkeletonGeometry from '@app/modules/pdf-viewer/runtime/lifecycle/commitPdfInitialPageSkeletonGeometry';
import { usePdfViewerPropModel } from '@app/modules/pdf-viewer/runtime/contracts/usePdfViewerPropModel';
import { usePdfCropSelection } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfCropSelection';
import { usePdfImagePlacement } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfImagePlacement';
import { usePdfRegionSnip } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfRegionSnip';
import {
    isPdfVisibleRenderRangeCurrent,
    resolvePdfProtectedVisibleRange,
} from '@app/modules/pdf-viewer/engine/pdf-visible-render-range-policy/isPdfVisibleRenderRangeCurrent';
import { usePdfViewerSelectionToolState } from '@app/modules/pdf-viewer/tools/public';
import { isStandaloneSpreadPage } from '@app/utils/pdfViewMode';
import { summarizeViewerMetrics } from '@app/modules/pdf-viewer/engine/pdf-viewer-metrics/summarizeViewerMetrics';
import type { IAnnotationModifiedPayload } from '@app/types/annotations';
import type { IPageRange } from '@app/types/pdfUi';
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
    const documentLifecycleKey = computed(() => props.originalPath ?? null);
    const pdfjsAnnotationEditorState = ref<IPdfjsAnnotationEditorState>(createEmptyPdfjsAnnotationEditorState());
    const { t } = useTypedI18n();
    const viewerEvents = createPdfViewerEventAdapter(emit);
    const emitAnnotationModified = (payload?: IAnnotationModifiedPayload) => viewerEvents.annotationModified(payload);
    const viewerHost = ref<HTMLElement | null>(null);
    const viewerContainer = ref<HTMLElement | null>(null);
    const summarizeViewerStateForLog = () => summarizeViewerMetrics(viewerContainer.value);
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
    const initialCanvasCommit = usePdfInitialCanvasCommitCoordinator({
        chassisAuthority,
        currentPage: computed(() => viewerCurrentPage.value),
    });

    const regionSnip = usePdfRegionSnip({ viewerContainer });
    const cropSelection = usePdfCropSelection({ viewerContainer });
    const {
        waitForViewerLoadSettled,
        cancelInitialVisualReady,
        handleRenderedPageStateChanged,
        handlePageCanvasMounted,
        commitInitialVisualReady,
        handlePageRendered,
        onDocumentLoadStateChange,
    } = usePdfViewerLoadLifecycleController({
        renderedPageStateVersion,
        getAnnotationRuntime: () => annotationRuntime,
        emitInitialVisualPending: (token) => {
            if (chassisAuthority) {
                const provisionalDocumentId = chassisAuthority.openSurface.snapshot.value.identity?.documentId;
                const generation = chassisAuthority.openSurface.claim({
                    // The host's provisional identity is the stable logical
                    // document id. Paths inside the feature pack may already
                    // point at a managed working copy and must only refine the
                    // revision, never replace the opening generation.
                    documentId: provisionalDocumentId
                        ?? String(props.originalPath ?? workingCopyPath.value ?? src.value ?? `pdf-open-${token}`),
                    documentRevision: String(documentRevisionToken.value ?? `load:${token}`),
                });
                initialCanvasCommit.begin(generation);
            }
            viewerEvents.initialVisualPending();
        },
        emitInitialVisualReady: viewerEvents.initialVisualReady,
        markDelayedSkeletonPageRendered: pageNumber => markDelayedSkeletonPageRendered(pageNumber),
        isInitialVisualCanvasReady: (pageNumber) => {
            if (pageNumber !== viewerCurrentPage.value) {
                return false;
            }
            const container = viewerContainer.value;
            const canvas = container?.querySelector<HTMLCanvasElement>(
                `.page_container[data-page="${pageNumber}"] .page_canvas canvas`,
            );
            if (!container || !canvas?.isConnected || canvas.width <= 0 || canvas.height <= 0) {
                return false;
            }
            const containerRect = container.getBoundingClientRect();
            const canvasRect = canvas.getBoundingClientRect();
            return canvasRect.width > 0
                && canvasRect.height > 0
                && canvasRect.bottom > containerRect.top
                && canvasRect.top < containerRect.bottom
                && canvasRect.right > containerRect.left
                && canvasRect.left < containerRect.right;
        },
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
    usePdfTrustedOpenGeometryLifecycle({
        props,
        src,
        viewerCurrentPage,
        chassisAuthority,
        pdfDocumentResult,
    });
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
        seedOpeningFitScale,
        resetScale,
    } = viewerRuntime.scale;

    function seedPreparedOpeningFitScale() {
        if (!chassisAuthority || zoomMode.value === 'custom') {
            return false;
        }
        const snapshot = chassisAuthority.openSurface.snapshot.value;
        const frame = snapshot.openingPageFrame;
        const geometry = snapshot.openingPageGeometry;
        const isOpening = snapshot.phase === 'pending'
            || snapshot.phase === 'geometry-committed'
            || snapshot.phase === 'canvas-committed'
            || snapshot.phase === 'viewport-committed';
        if (
            !isOpening
            || !frame
            || !geometry
            || frame.generation !== snapshot.generation
            || frame.pageNumber !== geometry.pageNumber
            || geometry.width <= 0
        ) {
            return false;
        }
        const preparedWidth = Number.parseFloat(frame.style.width ?? '');
        if (Number.isFinite(preparedWidth) && preparedWidth > 0) {
            // The prepared frame is the synchronous layout authority. Seed
            // the renderer from that exact geometry so its first canonical
            // canvas occupies the same box; the normal metric calculation
            // verifies/recomputes the value once document metadata is ready.
            return seedOpeningFitScale(preparedWidth / geometry.width);
        }
        return false;
    }
    watchEffect(seedPreparedOpeningFitScale);
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
        originalPath: computed(() => props.originalPath ?? null),
        src,
        sourcePdfData,
        workingCopyPath,
        documentRevisionToken,
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
    const relayPageRenderStall = (payload: IPageRenderStallPayload) => pageRenderStallRecoveryHandler?.(payload);
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
    let isVisibleRenderRangeCurrent = (range: IPageRange) => (
        isPdfVisibleRenderRangeCurrent({
            range,
            visibleRange: visibleRange.value,
            navigationTargetPage: null,
            viewMode: viewMode.value,
            totalPages: numPages.value,
        })
    );
    let getNavigationRenderTargetPage = (): number | null => null;
    let getOpeningVirtualExtentMinimumScrollHeight = (): number | null => 0;
    const userViewportInteractionEpoch = ref(0);
    const documentLoadToken = ref(0);
    let transactionController: ReturnType<typeof usePdfViewerTransactionController> | null = null;
    const renderSession = chassisAuthority?.renderCoordinator.createSession(
        `pdf-feature:${String(++nextPdfPageSlotOwnerId)}`,
    ) ?? null;
    const pageSlots = renderSession?.pageSlots ?? createPdfPageSlotRegistry();
    let renderDemandCoordinator: ReturnType<typeof usePdfRenderDemandCoordinator> | null = null;
    onScopeDispose(() => {
        if (renderSession) {
            renderSession.dispose();
            return;
        }
        pageSlots.dispose();
    });
    const {
        setupPagePlaceholders,
        renderVisiblePages,
        reRenderAllVisiblePages,
        invalidatePages: invalidateRenderedPages,
        applySearchHighlights,
        hideManagedAnnotationEditors,
        isPageRendered,
        isPageRendering,
        getPageRenderFailureToken,
        requestScrollToCurrentResult,
        cancelPendingSearchScroll,
        cancelInFlightRenders,
        renderAnnotationEditorLayerForPage,
        cleanupRenderedPages,
        releaseUnmountedPage,
        isPageFreshlyRenderedForNavigation,
        isPageRenderedForClass,
        isPageCanvasCommitted,
        getRenderAuthorityCursor,
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
        getProtectedVisibleRange: () => resolvePdfProtectedVisibleRange({
            visibleRange: visibleRange.value,
            navigationTargetPage: getNavigationRenderTargetPage(),
            viewMode: viewMode.value,
            totalPages: numPages.value,
        }),
        onPageCanvasMounted: (commit) => {
            renderDemandCoordinator?.notifyCanvasCommitted();
            if (chassisAuthority) {
                const surface = chassisAuthority.openSurface;
                const authoritativePageNumber = surface.viewportSession.value.requestedPage;
                logPdfRenderTrace('open-surface-canvas-observed', () => ({
                    pageNumber: commit.pageNumber,
                    authoritativePageNumber,
                    localCurrentPage: viewerCurrentPage.value,
                    commitGeneration: commit.openSurfaceGeneration,
                    surfaceGeneration: surface.snapshot.value.generation,
                    commitRevision: commit.documentRevision,
                    surfaceRevision: surface.snapshot.value.identity?.documentRevision ?? null,
                    surfacePhase: surface.snapshot.value.phase,
                }));
                if (commit.pageNumber !== authoritativePageNumber) {
                    handlePageCanvasMounted(commit);
                    return;
                }
                const generation = surface.snapshot.value.generation;
                const fence = surface.createRenderFence({
                    generation: commit.openSurfaceGeneration,
                    documentRevision: commit.documentRevision,
                    renderVersion: commit.renderVersion,
                    requestId: commit.requestId,
                    pageNumber: commit.pageNumber,
                });
                logPdfRenderTrace('open-surface-render-fence-created', () => ({
                    pageNumber: commit.pageNumber,
                    created: fence !== null,
                    viewportLifecycle: surface.viewportSession.value.lifecycle,
                    viewportIntentId: surface.viewportSession.value.viewportIntent?.id ?? null,
                }));
                if (fence) {
                    const geometryCommitted = initialPageSkeletonGeometry.commitPdfPageSkeletonGeometry(
                        chassisAuthority,
                        viewerContainer,
                        viewerCurrentPage,
                        scaledMargin,
                        commit.pageNumber,
                        {
                            authoritativePageNumber,
                            expectedGeneration: generation,
                            minimumScrollHeight: getOpeningVirtualExtentMinimumScrollHeight(),
                            requireVisibleSkeleton: false,
                        },
                    );
                    logPdfRenderTrace('open-surface-canvas-geometry-commit', () => ({
                        pageNumber: commit.pageNumber,
                        geometryCommitted,
                        surfacePhase: surface.snapshot.value.phase,
                        hasGeometry: surface.snapshot.value.geometry !== null,
                    }));
                    if (surface.commitCanvas(fence)) {
                        initialCanvasCommit.resolveCanvas(commit.openSurfaceGeneration, commit.pageNumber);
                        singlePageScroll.commitCurrentViewportIfSettled(commit.pageNumber);
                        initialCanvasCommit.tryComplete(commit.pageNumber, commitInitialVisualReady);
                    }
                }
            }
            handlePageCanvasMounted(commit);
        },
        resolveOpenSurfaceRenderContext: () => ({
            openSurfaceGeneration: chassisAuthority?.openSurface.snapshot.value.generation ?? 0,
            openSurfaceRevision: chassisAuthority?.openSurface.snapshot.value.identity?.documentRevision ?? '',
        }),
        onPageRendered: pageNumber => {
            handlePageRendered(pageNumber);
        },
        onAnnotationLayersRendered: pageNumber => applyEditedTextMarkupColorsForRenderedPage(pageNumber),
        onRenderedPageStateChanged: handleRenderedPageStateChanged,
        renderedPageStateVersion,
        requestMandatoryRender: (range, renderOptions) => requestMandatoryPdfRender(range, renderOptions),
    });
    function requestMandatoryPdfRender(
        range: IPageRange,
        renderOptions: IRenderVisiblePagesOptions = {},
    ) {
        return renderDemandCoordinator?.requestMandatoryRender(range, renderOptions)
            ?? renderVisiblePages(range, {
                ...renderOptions,
                openSurfaceGeneration: chassisAuthority?.openSurface.snapshot.value.generation ?? 0,
                openSurfaceRevision: chassisAuthority?.openSurface.snapshot.value.identity?.documentRevision ?? '',
            });
    }
    annotationRuntime.attachRenderingPort({
        renderVisiblePages: (range, renderOptions) => renderVisiblePages(range, {
            ...renderOptions,
            openSurfaceGeneration: chassisAuthority?.openSurface.snapshot.value.generation ?? 0,
            openSurfaceRevision: chassisAuthority?.openSurface.snapshot.value.identity?.documentRevision ?? '',
        }),
        renderAnnotationEditorLayerForPage,
        isPageRendered,
        invalidatePages: invalidateRenderedPages,
        hideManagedAnnotationEditors,
    });
    isVisibleRenderRangeCurrent = (range: IPageRange) => {
        return isPdfVisibleRenderRangeCurrent({
            range,
            visibleRange: visibleRange.value,
            navigationTargetPage: getNavigationRenderTargetPage(),
            viewMode: viewMode.value,
            totalPages: numPages.value,
        });
    };
    const navigationOrchestration = usePdfViewerNavigationOrchestration({
        singlePageOptions: {
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
            renderVisiblePages: requestMandatoryPdfRender,
            ensurePageMetricsInRange: pdfDocumentResult.ensurePageMetricsInRange,
            isPageFreshlyRenderedForNavigation,
            visibleRange,
            emitCurrentPage: viewerEvents.updateCurrentPage,
            emitNavigationFeedbackPage: viewerEvents.updateNavigationFeedbackPage,
            viewportWritePort: viewerRuntime.scroll.viewportWritePort,
            getPageLayoutMetrics: viewerRuntime.scroll.getPageLayoutMetrics,
            bindCurrentPageProjection: viewerRuntime.scroll.bindCurrentPageProjection,
            // Viewport intents belong to a source-load generation. Render
            // versions fence canvas work and may advance independently.
            getDocumentRevision: () => documentLoadToken.value,
            getGeometryRevision: () => pageMetricsVersion.value + 1,
            pageSlots,
            requestedCurrentPage,
            cancelPendingSearchScroll,
            onViewportPositionCommitted: (commit) => {
                const surface = chassisAuthority?.openSurface;
                // Project the authoritative navigation result into the shared
                // chassis session before marking its viewport committed. If
                // the request projection remains on the preceding page, the
                // next zoom/fit transaction can correctly preserve page 7 in
                // the renderer while the chassis still asks it to render page
                // 1. The emit is synchronous; the chassis turns it into the
                // session's requested page, after which the viewport commit
                // completes the same page transition.
                // Commit directly at the authority boundary; the component
                // event remains a compatibility projection for outer UI state.
                surface?.requestNavigation(commit.page);
                viewerEvents.updateCurrentPage(commit.page);
                if (!surface || !commitPdfOpenSurfaceViewport(surface, commit)) {
                    return;
                }
                initialCanvasCommit.tryComplete(commit.page, commitInitialVisualReady);
            },
        },
        transactionOptions: {
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
        },
        viewerCurrentPage,
        chassisAuthority,
        initialCanvasCommit,
        commitInitialVisualReady,
        zoom,
        fitMode,
        viewMode,
        outputScale,
        pdfDocument,
        isLoading,
        isResizing,
        visibleRange,
        reRenderAllVisiblePages,
        isActive,
        userViewportInteractionEpoch,
    });
    const {
        singlePageScroll,
        markUserViewportInteraction,
        handleLinkDestination,
        markAnchoredZoomSubmitted,
    } = navigationOrchestration;
    transactionController = navigationOrchestration.transactionController;
    const { navigationAnchorPage } = singlePageScroll;
    getNavigationRenderTargetPage = () => (
        transactionController?.targetPage.value
        ?? navigationAnchorPage.value
        ?? null
    );

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
        bottomVirtualSpacerStyle: virtualizedBottomVirtualSpacerStyle,
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
        bottomVirtualSpacerStyle,
        openingVirtualExtentMinimumScrollHeight,
        getExactPagePlaceholderStyle,
    } = usePdfOpenVirtualSurfaceGeometry({
        chassisAuthority,
        continuousScroll,
        viewMode,
        scaledMargin,
        virtualizedBottomVirtualSpacerStyle,
        getLastMountedPage: () => virtualPageSegments.value.at(-1)?.end,
        viewerContainer,
        zoomMode,
        hasExactPageGeometry: pdfDocumentResult.hasExactPageGeometry,
        isFitWidthScaleCurrent,
        getPagePlaceholderStyle,
    });
    getOpeningVirtualExtentMinimumScrollHeight = () =>
        openingVirtualExtentMinimumScrollHeight.value;
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
            consumeAuthorityScroll: singlePageScroll.consumeAuthorityScroll,
            cancelProgrammaticNavigation: singlePageScroll.cancelProgrammaticNavigation,
            isProgrammaticNavigationActive: singlePageScroll.isProgrammaticNavigationActive,
            shouldCancelProgrammaticNavigationForViewportScroll:
                singlePageScroll.shouldCancelProgrammaticNavigationForViewportScroll,
        },
        cancelPendingSearchScroll,
        markUserViewportInteraction,
        submitZoomIntent: (intent) => {
            markAnchoredZoomSubmitted(intent.zoom);
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
        documentLifecycleKey,
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
        seedOpeningFitScale: seedPreparedOpeningFitScale,
        computeSkeletonInsets,
        resetInsets,
        setupPagePlaceholders,
        renderVisiblePages: (range, renderOptions) => renderVisiblePages(range, {
            ...renderOptions,
            openSurfaceGeneration: chassisAuthority?.openSurface.snapshot.value.generation ?? 0,
            openSurfaceRevision: chassisAuthority?.openSurface.snapshot.value.identity?.documentRevision ?? '',
        }),
        reRenderAllVisiblePages,
        cancelInFlightPageRenders: cancelInFlightRenders,
        cancelPendingSearchScroll,
        cleanupRenderedPages,
        invalidateRenderedPages,
        shouldPreserveOpeningLayout: () => {
            const snapshot = chassisAuthority?.openSurface.snapshot.value;
            return snapshot !== undefined && hasCommittedDocumentOpeningLayout(snapshot);
        },
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
        commitReloadViewport: (pageNumber, options) => {
            scrollToPageInternal(
                viewerContainer.value,
                pageNumber,
                numPages.value,
                scaledMargin.value,
                options,
            );
            singlePageScroll.commitCurrentViewportPosition(
                pageNumber,
                `reload-viewport-${String(documentLoadToken.value)}-${String(pageNumber)}`,
            );
        },
        resetContinuousScrollState: () => singlePageScroll.resetContinuousScrollState(),
        cancelDestinationNavigationTarget: () => singlePageScroll.cancelDestinationNavigationTarget(),
        getUserViewportInteractionEpoch: () => userViewportInteractionEpoch.value,
        cancelInitialVisualReady,
        waitForInitialCanvasCommit: initialCanvasCommit.waitForCanvas,
        isInitialCanvasCommitted: initialCanvasCommit.isInitialCanvasCommitted,
        isInitialVisualCommitted: initialCanvasCommit.isInitialVisualCommitted,
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

    renderDemandCoordinator = usePdfRenderDemandCoordinator({
        visibleRange,
        pagesToRender,
        pageSlots,
        isActive,
        isLoading,
        pdfDocument,
        numPages,
        renderStateVersion: renderedPageStateVersion,
        getRenderGeneration: () => getRenderAuthorityCursor().renderVersion,
        isPageReady: isPageCanvasCommitted,
        isPageRendering,
        getPageFailureToken: getPageRenderFailureToken,
        renderVisiblePages: (range, renderOptions) => renderVisiblePages(range, {
            ...renderOptions,
            openSurfaceGeneration: chassisAuthority?.openSurface.snapshot.value.generation ?? 0,
            openSurfaceRevision: chassisAuthority?.openSurface.snapshot.value.identity?.documentRevision ?? '',
        }),
    });

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
    function isPageVisualReadyForShapeOverlay(pageNumber: number) {
        return (
            isPageCanvasCommitted(pageNumber)
        );
    }
    function isPageVisuallyReady(pageNumber: number) {
        return isPageCanvasCommitted(pageNumber);
    }
    function isPageRenderFailed(pageNumber: number) {
        // Render slots are intentionally non-reactive. Reading the shared
        // version makes terminal readiness participate in Vue's render graph.
        void renderedPageStateVersion.value;
        return renderDemandCoordinator?.getPageVisualReadiness(pageNumber) === 'error';
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
        renderDemandCoordinator?.notifyPageMounted();
    }
    function handlePageContainerUnmounted(pageNumber: number) {
        pageSlots.markUnmounted(pageNumber);
        renderDemandCoordinator?.notifyPageUnmounted();
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
        isPageRenderFailed,
        shouldShowSkeleton: shouldShowNavigationSkeleton,
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
        renderedPageStateVersion: readonly(renderedPageStateVersion),
        annotationUiManager,
        viewerClass,
        containerStyle,
        scaledMargin,
        openingVirtualExtentMinimumScrollHeight,
        pagesToRender,
        virtualPageSegments,
        shouldShowPageSkeleton,
        isPageRenderFailed,
        isSpreadSingle,
        isPageBuffered,
        isPageRenderedForClass,
        isPageVisualReadyForShapeOverlay,
        getPagePlaceholderStyle,
        getExactPagePlaceholderStyle,
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
