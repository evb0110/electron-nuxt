import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type { IPdfjsL10n } from '@app/types/pdfjs';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { TPdfRasterDisplayProfile } from '@app/types/pdfRasterDisplayProfile';
import type {
    IPageRange,
    IPdfPageMatches,
    IPdfSearchMatch,
} from '@app/types/pdfUi';
import type {
    TFitMode,
    TPdfViewMode,
    TZoomMode,
} from '@app/types/pdfContracts';
import { BrowserLogger } from '@app/utils/browserLogger';
import { runGuardedTask } from '@app/utils/asyncGuard';
import { markStartupMetricOnce } from '@app/utils/startupMetrics';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import type { IDocumentViewerChassisAuthority } from '@app/utils/document-viewer/chassis/documentViewerChassisAuthority';
import type { IDocumentOpenSurfaceRenderOwner } from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';
import type { IPdfRenderPerformancePolicy } from '@app/modules/pdf-viewer/engine/pdf-render-performance/resolvePdfRenderPerformancePolicy';
import { PDF_RERENDER_SOURCE } from '@app/modules/pdf-viewer/runtime/rerender-protocol/pdfRerenderProtocol';
import { shouldDeferPdfDprRerenderForResize } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerOutputScale';
import { usePdfPageRenderer } from '@app/modules/pdf-viewer/runtime/rendering/usePdfPageRenderer';
import type { IPdfCanvasDomCommit } from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';
import { usePdfViewerRerenderCoordinator } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerRerenderCoordinator';
import { usePdfViewerResizeLifecycle } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerResizeLifecycle';
import { usePdfViewerZoomRerenderQueue } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerZoomRerenderQueue';
import { usePdfViewerRenderStallRecovery } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerRenderStallRecovery';
import { usePdfViewerInitialRenderRecovery } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerInitialRenderRecovery';
import { usePdfViewerActivationRestore } from '@app/modules/pdf-viewer/runtime/lifecycle/usePdfViewerActivationRestore';
import { usePdfInitialCanvasCommitCoordinator } from '@app/modules/pdf-viewer/runtime/lifecycle/usePdfInitialCanvasCommitCoordinator';
import { isPdfInitialVisualCanvasReady } from '@app/modules/pdf-viewer/runtime/lifecycle/isPdfInitialVisualCanvasReady';
import * as initialPageSkeletonGeometry from '@app/modules/pdf-viewer/runtime/lifecycle/commitPdfInitialPageSkeletonGeometry';
import type { ICurrentPageSyncOptions } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerCurrentPageSync';
import type { IZoomViewportAnchor } from '@app/modules/pdf-viewer/runtime/viewport/pdfViewerViewportTypes';
import type { TZoomInteractionLockOperationId } from '@app/modules/pdf-viewer/runtime/zoom/pdfViewerZoomTypes';
import type { IPdfSemanticAnchor } from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportGeometry';
import type { TPdfDocumentSession } from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';
import type {
    IPdfViewportDemand,
    TPdfViewportSession,
} from '@app/modules/pdf-viewer/runtime/sessions/createPdfViewportSession';

const QUALITY_REFINE_INPUT_IDLE_MS = 160;
const EMPTY_ID_SET: ReadonlySet<string> = new Set<string>();

type TPdfPageVisualReadiness = 'unmounted' | 'queued' | 'rendering' | 'ready' | 'error';

/**
 * Declared inline because it has exactly one annotation-session
 * implementation; it does not earn a separate port file.
 */
interface IPdfAnnotationProjection {
    readonly annotationUiManager: ShallowRef<AnnotationEditorUIManager | null>;
    readonly annotationL10n: ShallowRef<IPdfjsL10n | null>;
    readonly hiddenAnnotationIds: Readonly<Ref<Set<string>>>;
    readonly canvasHiddenAnnotationIds: Readonly<Ref<Set<string>>>;
    readonly managedAnnotationIds: Readonly<Ref<Set<string>>>;
    replaceAnnotationUiManager(manager: AnnotationEditorUIManager): void;
    pageLayersRendered(pageNumber: number, container: HTMLElement): void;
    pageCommitted(pageNumber: number): void;
}

export interface ICreatePdfRenderingSessionOptions {
    document: TPdfDocumentSession;
    viewport: TPdfViewportSession;
    chassisAuthority: IDocumentViewerChassisAuthority | null;
    openSurfaceRenderOwner: IDocumentOpenSurfaceRenderOwner | undefined;
    performancePolicy: IPdfRenderPerformancePolicy;
    viewerContainer: Ref<HTMLElement | null>;
    isActive: ComputedRef<boolean>;
    isResizing: ComputedRef<boolean>;
    isAnySaving: ComputedRef<boolean>;
    zoom: ComputedRef<number>;
    zoomMode: ComputedRef<TZoomMode>;
    fitMode: ComputedRef<TFitMode>;
    viewMode: ComputedRef<TPdfViewMode>;
    continuousScroll: ComputedRef<boolean>;
    outputScale: Ref<number>;
    rasterDisplayProfile: ComputedRef<TPdfRasterDisplayProfile | null>;
    bufferPages: ComputedRef<number>;
    showAnnotations: ComputedRef<boolean>;
    searchPageMatches: ComputedRef<Map<number, IPdfPageMatches>>;
    currentSearchMatch: ComputedRef<IPdfSearchMatch | null>;
    currentSearchMatchNavigationId: ComputedRef<number>;
    workingCopyPath: ComputedRef<string | null>;
    documentRevisionToken: ComputedRef<TDocumentRevisionToken | null>;
    maxBufferCanvasPixels: number;
    consumeZoomViewportAnchor: () => IZoomViewportAnchor | null;
    isZoomInteractionLocked: () => boolean;
    setZoomRerenderBusy: (
        busy: boolean,
        signal?: {
            operationId?: TZoomInteractionLockOperationId | null | undefined;
            reason: string;
        },
    ) => TZoomInteractionLockOperationId | null | undefined;
    markDelayedSkeletonPageRendered: (pageNumber: number) => void;
    emitInitialVisualReady: (payload: {pageNumber: number}) => void;
    emitLoadError: (error: unknown) => void;
}

/**
 * Owns rasterized output: the page renderer, the raster demand executor, the
 * open-surface canvas fence and the first committed canvas of every open.
 */
export const createPdfRenderingSession = (options: ICreatePdfRenderingSessionOptions) => {
    const documentSession = options.document;
    const viewport = options.viewport;
    const chassisAuthority = options.chassisAuthority;
    const renderedPageStateVersion = ref(0);
    const projection = shallowRef<IPdfAnnotationProjection | null>(null);
    const emptyManagerRef = shallowRef<AnnotationEditorUIManager | null>(null);
    const emptyL10nRef = shallowRef<IPdfjsL10n | null>(null);
    const hiddenAnnotationIds = computed(() => projection.value?.hiddenAnnotationIds.value ?? EMPTY_ID_SET as Set<string>);
    const canvasHiddenAnnotationIds = computed(() => projection.value?.canvasHiddenAnnotationIds.value ?? EMPTY_ID_SET as Set<string>);
    const managedAnnotationIds = computed(() => projection.value?.managedAnnotationIds.value ?? EMPTY_ID_SET as Set<string>);

    const initialCanvasCommit = usePdfInitialCanvasCommitCoordinator({
        chassisAuthority,
        currentPage: viewport.currentPage,
    });
    let pendingInitialVisualReadyToken: number | null = null;

    function resolveOpenSurfaceRenderContext() {
        return {
            openSurfaceGeneration: documentSession.openSurfaceGeneration,
            openSurfaceRevision: documentSession.openSurfaceRevision,
        };
    }

    function commitInitialVisualReady(pageNumber: number) {
        if (
            pendingInitialVisualReadyToken === null
            || !isPdfInitialVisualCanvasReady(
                options.viewerContainer.value,
                pageNumber,
                viewport.currentPage.value,
            )
        ) {
            return false;
        }
        const token = pendingInitialVisualReadyToken;
        pendingInitialVisualReadyToken = null;
        markStartupMetricOnce('evb:first-page-painted');
        options.emitInitialVisualReady({ pageNumber });
        BrowserLogger.debug('loader', 'PDF viewer initial visual ready', {
            token,
            pageNumber,
            source: 'canvas-dom-commit',
        });
        return true;
    }

    function tryCompleteInitialVisual(pageNumber: number) {
        return initialCanvasCommit.tryComplete(pageNumber, commitInitialVisualReady);
    }

    /** Joins a fresh resident PDF raster to the current shared viewport intent. */
    function adoptResidentCanvas(pageNumber: number) {
        if (!chassisAuthority || !options.openSurfaceRenderOwner || !rendering.isPageCanvasCommitted(pageNumber)) {
            return false;
        }
        const surface = chassisAuthority.openSurface;
        const snapshot = surface.snapshot.value;
        if (snapshot.identity === null || surface.viewportSession.value.requestedPage !== pageNumber) {
            return false;
        }
        const fence = surface.createOwnedResidentRenderFence(options.openSurfaceRenderOwner, {
            generation: snapshot.generation,
            documentRevision: snapshot.identity.documentRevision,
            pageNumber,
        });
        if (!fence || !surface.commitCanvas(fence)) {
            return false;
        }
        initialCanvasCommit.resolveCanvas(snapshot.generation, pageNumber);
        tryCompleteInitialVisual(pageNumber);
        return true;
    }

    function handlePageCanvasMounted(commit: IPdfCanvasDomCommit) {
        renderedPageStateVersion.value += 1;
        projection.value?.pageCommitted(commit.pageNumber);
        notifyRenderStateChanged();
        if (!chassisAuthority) {
            return;
        }
        const surface = chassisAuthority.openSurface;
        const authoritativePageNumber = surface.viewportSession.value.requestedPage;
        logPdfRenderTrace('open-surface-canvas-observed', () => ({
            pageNumber: commit.pageNumber,
            authoritativePageNumber,
            localCurrentPage: viewport.currentPage.value,
            commitGeneration: commit.openSurfaceGeneration,
            surfaceGeneration: surface.snapshot.value.generation,
            commitRevision: commit.documentRevision,
            surfaceRevision: surface.snapshot.value.identity?.documentRevision ?? null,
            surfacePhase: surface.snapshot.value.phase,
        }));
        if (commit.pageNumber !== authoritativePageNumber) {
            return;
        }
        const generation = surface.snapshot.value.generation;
        const fence = options.openSurfaceRenderOwner && surface.createOwnedRenderFence(options.openSurfaceRenderOwner, {
            generation: commit.openSurfaceGeneration,
            documentRevision: commit.documentRevision,
            rendererVersion: commit.renderVersion,
            rendererRequestId: commit.requestId,
            pageNumber: commit.pageNumber,
        });
        logPdfRenderTrace('open-surface-render-fence-created', () => ({
            pageNumber: commit.pageNumber,
            created: fence !== null,
            viewportLifecycle: surface.viewportSession.value.lifecycle,
            viewportIntentId: surface.viewportSession.value.viewportIntent?.id ?? null,
        }));
        if (!fence) {
            return;
        }
        const geometryCommitted = initialPageSkeletonGeometry.commitPdfPageSkeletonGeometry(
            chassisAuthority,
            options.viewerContainer,
            viewport.currentPage,
            viewport.scale.scaledMargin,
            commit.pageNumber,
            {
                authoritativePageNumber,
                expectedGeneration: generation,
                minimumScrollHeight: viewport.openVirtualSurfaceGeometry.openingVirtualExtentMinimumScrollHeight.value,
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
            viewport.singlePageScroll.commitCurrentViewportIfSettled(commit.pageNumber);
            tryCompleteInitialVisual(commit.pageNumber);
        }
    }

    // A warm pane still owes the chassis its mandatory opening raster. Keep
    // ordinary background demand suspended, but let that bounded handshake
    // complete before the workspace promotes the pane to active.
    const rasterOperational = computed(() => (
        options.isActive.value || viewport.demand.value.mandatoryRaster !== null
    ));
    const rendering = usePdfPageRenderer({
        container: options.viewerContainer,
        document: documentSession,
        currentPage: viewport.currentPage,
        isActive: rasterOperational,
        effectiveScale: viewport.scale.effectiveScale,
        outputScale: options.outputScale,
        rasterDisplayProfile: options.rasterDisplayProfile,
        bufferPages: options.bufferPages,
        showAnnotations: options.showAnnotations,
        hiddenAnnotationIds,
        canvasHiddenAnnotationIds,
        managedAnnotationIds,
        annotationUiManager: computed(() => projection.value?.annotationUiManager.value ?? emptyManagerRef.value),
        annotationL10n: computed(() => projection.value?.annotationL10n.value ?? emptyL10nRef.value),
        replaceAnnotationUiManager: manager => projection.value?.replaceAnnotationUiManager(manager),
        setupPagePlaceholders: viewport.setupPagePlaceholders,
        scrollToPage: (pageNumber, scrollOptions) => viewport.singlePageScroll.scrollToPage(pageNumber, scrollOptions),
        suppressSnap: () => undefined,
        beginSearchNavigation: (pageNumber) => {
            viewport.markUserViewportInteraction();
            viewport.singlePageScroll.beginSearchNavigation(pageNumber);
        },
        revealSearchNavigationTarget: (pageNumber, revealOptions) =>
            viewport.singlePageScroll.revealSearchNavigationTarget(pageNumber, revealOptions),
        endSearchNavigation: () => viewport.singlePageScroll.endSearchNavigation(),
        beginSearchTransaction: (pageNumber, searchOptions) => (
            viewport.transactionController.beginTransaction({
                kind: 'search',
                source: 'search-navigation',
                page: pageNumber,
                anchor: searchOptions?.markerRect ? 'marker' : 'top',
                markerRect: searchOptions?.markerRect ?? null,
            })?.id ?? null
        ),
        isSearchTransactionCurrent: transactionId => viewport.transactionController.isTransactionCurrent(transactionId),
        settleSearchTransaction: transactionId => {
            viewport.transactionController.advanceTransaction(transactionId, 'settled');
        },
        cancelSearchTransaction: transactionId => {
            viewport.transactionController.cancelActiveTransaction({
                reason: 'superseded',
                cancelInFlightRenders: false,
                bumpRenderVersion: false,
                preserveVisualContent: true,
            }, transactionId);
        },
        searchPageMatches: options.searchPageMatches,
        currentSearchMatch: options.currentSearchMatch,
        currentSearchMatchNavigationId: options.currentSearchMatchNavigationId,
        workingCopyPath: options.workingCopyPath,
        documentRevisionToken: options.documentRevisionToken,
        viewportWritePort: viewport.viewportWritePort,
        onRenderStall: payload => handlePageRenderStall(payload),
        onPageCanvasMounted: handlePageCanvasMounted,
        resolveOpenSurfaceRenderContext,
        onPageRendered: (pageNumber) => {
            options.markDelayedSkeletonPageRendered(pageNumber);
            projection.value?.pageCommitted(pageNumber);
        },
        onAnnotationLayersRendered: (pageNumber, container) => {
            projection.value?.pageLayersRendered(pageNumber, container);
        },
        isVisibleRenderRangeCurrent: range => viewport.isVisibleRenderRangeCurrent(range),
        getProtectedVisibleRange: () => viewport.getProtectedVisibleRange(),
        onRenderedPageStateChanged: () => {
            renderedPageStateVersion.value += 1;
            notifyRenderStateChanged();
        },
        pageSlots: viewport.pageSlots,
    });

    function renderVisiblePages(
        range: IPageRange,
        renderOptions: Parameters<typeof rendering.renderVisiblePages>[1] = {},
    ) {
        return rendering.renderVisiblePages(range, {
            ...renderOptions,
            ...resolveOpenSurfaceRenderContext(),
        });
    }

    function cleanupRenderedPages() {
        void rendering.cleanupAllPages();
        renderedPageStateVersion.value += 1;
    }

    function isPageVisualReady(pageNumber: number) {
        // Render slots are intentionally non-reactive. Reading the shared
        // version makes readiness participate in Vue's render graph.
        void renderedPageStateVersion.value;
        return rendering.isPageCanvasCommitted(pageNumber);
    }

    // ---- raster demand execution -------------------------------------------

    let frameId: number | null = null;
    let qualityRefineIdleTimer: number | null = null;
    let observedViewportInteractionEpoch = viewport.userViewportInteractionEpoch.value;
    let lastViewportInteractionAtMs = Date.now();
    let latestDemand: IPdfViewportDemand = viewport.demand.value;
    let activeMandatoryRasterId: number | null = null;
    let disposed = false;

    function clearQualityRefineIdleTimer() {
        if (qualityRefineIdleTimer === null) {
            return;
        }
        window.clearTimeout(qualityRefineIdleTimer);
        qualityRefineIdleTimer = null;
    }

    function synchronizeViewportInteractionEpoch() {
        const epoch = viewport.userViewportInteractionEpoch.value;
        if (epoch === observedViewportInteractionEpoch) {
            return;
        }
        observedViewportInteractionEpoch = epoch;
        lastViewportInteractionAtMs = Date.now();
        clearQualityRefineIdleTimer();
    }

    function hasPendingInput() {
        const scheduling = typeof navigator === 'undefined'
            ? undefined
            : (navigator as Navigator & {scheduling?: {isInputPending?: () => boolean}}).scheduling;
        return typeof scheduling?.isInputPending === 'function' && scheduling.isInputPending();
    }

    function canRefineVisibleRaster() {
        if ((options.performancePolicy.clampedVisibleRefineMode ?? 'immediate') === 'immediate') {
            return true;
        }
        synchronizeViewportInteractionEpoch();
        const remainingIdleMs = QUALITY_REFINE_INPUT_IDLE_MS - (Date.now() - lastViewportInteractionAtMs);
        if (
            remainingIdleMs <= 0
            && viewport.transactionController.activeTransaction.value === null
            && !hasPendingInput()
        ) {
            return true;
        }
        qualityRefineIdleTimer ??= window.setTimeout(() => {
            qualityRefineIdleTimer = null;
            queueFrame();
        }, Math.max(remainingIdleMs, QUALITY_REFINE_INPUT_IDLE_MS));
        return false;
    }

    function queueFrame() {
        if (disposed || frameId !== null) {
            return;
        }
        frameId = window.requestAnimationFrame(() => {
            frameId = null;
            reconcileDemand();
        });
    }

    function reconcileDemand() {
        synchronizeViewportInteractionEpoch();
        const demand = latestDemand;
        if (!demand.operational) {
            if (demand.mandatoryRaster) {
                viewport.settleMandatoryRaster(demand.mandatoryRaster.id);
            }
            void rendering.cancelRasterDemand();
            return;
        }
        const mandatory = demand.mandatoryRaster;
        if (mandatory) {
            if (activeMandatoryRasterId === mandatory.id) {
                return;
            }
            activeMandatoryRasterId = mandatory.id;
            void renderVisiblePages(mandatory.range, mandatory.options).finally(() => {
                if (activeMandatoryRasterId === mandatory.id) {
                    activeMandatoryRasterId = null;
                }
                viewport.settleMandatoryRaster(mandatory.id);
            });
            return;
        }
        const missingRequiredPages = demand.requiredPages.filter(page => !rendering.isPageCanvasCommitted(page));
        if (missingRequiredPages.length > 0) {
            void renderVisiblePages(demand.visibleRange, {
                bufferMaxCanvasPixels: options.maxBufferCanvasPixels,
                // Strict readiness also rejects a resident canvas at a stale
                // scale. Force the promotion so the renderer cannot take its
                // resident-canvas shortcut and strand the page as a skeleton.
                forceRerender: true,
                preserveInFlightRequiredPages: true,
                preserveRenderedPages: true,
                rasterDemandPages: demand.residentPages,
            });
            return;
        }
        const layerPromotionPages = demand.requiredPages.filter(page => !rendering.isPageLayerReady(page));
        if (layerPromotionPages.length > 0) {
            const promotionRange = {
                start: Math.min(...layerPromotionPages),
                end: Math.max(...layerPromotionPages),
            };
            void renderVisiblePages(promotionRange, {
                bufferOverride: 0,
                contentIntent: 'layers-only-promotion',
                preserveInFlightRequiredPages: true,
                preserveRenderedPages: true,
                rasterDemandPages: layerPromotionPages,
                renderWindowOverride: promotionRange,
            });
            return;
        }
        const refinePage = demand.requiredPages.find(page => rendering.isPageQualityRefineEligible(page));
        if (refinePage !== undefined && canRefineVisibleRaster()) {
            clearQualityRefineIdleTimer();
            void renderVisiblePages({
                start: refinePage,
                end: refinePage,
            }, {
                bufferOverride: 0,
                contentIntent: 'canvas-only-refine',
                forceRerender: true,
                preserveCommittedVisual: true,
                preserveInFlightRequiredPages: true,
                preserveRenderedPages: true,
                rasterDemandPages: [refinePage],
            });
            return;
        }
        void renderVisiblePages(demand.visibleRange, {
            bufferMaxCanvasPixels: options.maxBufferCanvasPixels,
            preserveInFlightRequiredPages: true,
            preserveRenderedPages: true,
            rasterDemandPages: demand.residentPages,
        });
    }

    function notifyRenderStateChanged() {
        viewport.notifyRenderStateChanged();
    }

    function getPageVisualReadiness(pageNumber: number): TPdfPageVisualReadiness {
        if (!viewport.pageSlots.isMounted(pageNumber)) {
            return 'unmounted';
        }
        if (rendering.isPageCanvasCommitted(pageNumber)) {
            return 'ready';
        }
        if (rendering.getPageRenderFailureToken(pageNumber) !== null) {
            return 'error';
        }
        if (rendering.isPageRendering(pageNumber)) {
            return 'rendering';
        }
        return 'queued';
    }

    const stopDemandWatch = watch(viewport.demand, (demand) => {
        latestDemand = demand;
        queueFrame();
    }, {
        flush: 'sync',
        immediate: true,
    });
    const stopCancelRasterWatch = watch(viewport.cancelRasterRevision, (revision, previous) => {
        if (revision !== previous) {
            void rendering.cancelInFlightRenders();
        }
    }, {flush: 'sync'});
    const stopCancelSearchWatch = watch(viewport.cancelPendingSearchRevision, (revision, previous) => {
        if (revision !== previous) {
            rendering.cancelPendingSearchScroll();
        }
    }, {flush: 'sync'});
    const stopVisualReadyWatch = watch(viewport.visualReadySignal, (signal, previous) => {
        if (signal.revision !== previous?.revision) {
            adoptResidentCanvas(signal.pageNumber);
        }
    }, {flush: 'sync'});
    const stopNavigationCommitWatch = watch(viewport.navigationCommittedSignal, (signal, previous) => {
        if (signal.revision !== previous?.revision) {
            tryCompleteInitialVisual(signal.pageNumber);
        }
    }, {flush: 'sync'});

    // ---- rerender / resize / zoom -------------------------------------------

    let rerenderVisiblePagesAndSyncCurrentPage: (
        syncOptions?: ICurrentPageSyncOptions,
    ) => Promise<void> = async () => {};
    let scheduleResizeAwareRerender: (stage: string, syncOptions?: ICurrentPageSyncOptions) => void = () => {};
    let suppressedZoomRerenderTarget: number | null = null;

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
        captureResizeVisualSnapshots,
        scheduleEndResizeTransition,
        cleanupResizeLifecycle,
    } = usePdfViewerResizeLifecycle({
        submitResizeIntent: anchor => void viewport.singlePageScroll.submitViewportStateIntent(
            'resize', anchor ? {anchor} : {},
        ),
        applyResizeAnchorPreview: (anchor?: IPdfSemanticAnchor | null) =>
            viewport.singlePageScroll.applyResizeAnchorPreview(anchor),
        viewerContainer: options.viewerContainer,
        isLoading: documentSession.isLoading,
        isActive: options.isActive,
        isResizing: options.isResizing,
        pdfDocument: documentSession.pdfDocument,
        currentPage: viewport.currentPage,
        pendingNavigationAnchorPage: viewport.singlePageScroll.navigationAnchorPage,
        visibleRange: viewport.visibleRange,
        numPages: documentSession.numPages,
        computeFitWidthScale: viewport.scale.computeFitWidthScale,
        settlePreviewFitScale: viewport.scale.settlePreviewFitScale,
        captureViewportAnchor: viewport.singlePageScroll.captureCurrentSemanticAnchor,
        getMostVisiblePage: viewport.scroll.getMostVisiblePage,
        summarizeViewerMetricsForLog: viewport.summarizeViewerMetricsForLog,
        summarizeVisiblePageSnapshotForLog: viewport.summarizeVisiblePageSnapshotForLog,
        scheduleResizeAwareRerender: (stage, syncOptions) => scheduleResizeAwareRerender(stage, syncOptions),
        setResizeTransitionVisible: viewport.handleResizeTransitionSignal,
        transactionController: viewport.transactionController,
    });

    const zoomRerenderQueue = usePdfViewerZoomRerenderQueue({
        performancePolicy: options.performancePolicy,
        pdfDocument: documentSession.pdfDocument,
        isLoading: documentSession.isLoading,
        viewerContainer: options.viewerContainer,
        summarizeViewerMetricsForLog: viewport.summarizeViewerMetricsForLog,
        reRenderVisiblePagesAndSyncCurrentPage: syncOptions => rerenderVisiblePagesAndSyncCurrentPage(syncOptions),
        buildResizeAnchorContext: () => buildResizeAnchorContext(),
        scheduleEndResizeTransition,
        isZoomInteractionLocked: options.isZoomInteractionLocked,
        isZoomGestureSessionLocked: options.isZoomInteractionLocked,
        setZoomRerenderBusy: options.setZoomRerenderBusy,
        transactionController: viewport.transactionController,
    });
    scheduleResizeAwareRerender = zoomRerenderQueue.scheduleResizeAwareRerender;

    rerenderVisiblePagesAndSyncCurrentPage = usePdfViewerRerenderCoordinator({
        viewerContainer: options.viewerContainer,
        pdfDocument: documentSession.pdfDocument,
        isLoading: documentSession.isLoading,
        numPages: documentSession.numPages,
        currentPage: viewport.currentPage,
        pagedNavigationTargetPage: viewport.singlePageScroll.pagedNavigationTargetPage,
        navigationAnchorPage: viewport.singlePageScroll.navigationAnchorPage,
        visibleRange: viewport.visibleRange,
        commitVisibleRange: range => viewport.commitVisibleRange(range, null),
        zoom: options.zoom,
        fitMode: options.fitMode,
        viewMode: options.viewMode,
        isResizing: options.isResizing,
        continuousScroll: options.continuousScroll,
        getVisibleRange: viewport.getVisibleRange,
        reRenderAllVisiblePages: rendering.reRenderAllVisiblePages,
        summarizeViewerMetricsForLog: viewport.summarizeViewerMetricsForLog,
        summarizeVisiblePageSnapshotForLog: viewport.summarizeVisiblePageSnapshotForLog,
        syncCurrentPageFromViewport: viewport.syncCurrentPageFromViewport,
        buildResizeAnchorContext,
        captureResizeVisualSnapshots,
        scheduleEndResizeTransition,
        enqueueZoomSync: syncOptions => zoomRerenderQueue.enqueueZoomSync(syncOptions),
        scheduleResizeAwareRerender: (stage, syncOptions) => scheduleResizeAwareRerender(stage, syncOptions),
        cancelInFlightPageRenders: rendering.cancelInFlightRenders,
        ensurePageMetricsInRange: documentSession.ensurePageMetricsInRange,
        computeFitWidthScale: viewport.scale.computeFitWidthScale,
        zoomMode: options.zoomMode,
        syncHorizontalScrollForZoomMode: viewport.viewModel.syncHorizontalScrollForZoomMode,
        setupPagePlaceholders: viewport.setupPagePlaceholders,
        scrollToPage: (pageNumber, scrollOptions) => viewport.singlePageScroll.scrollToPage(pageNumber, scrollOptions),
        getMostVisiblePage: viewport.scroll.getMostVisiblePage,
        resetContinuousScrollState: () => viewport.singlePageScroll.resetContinuousScrollState(),
        cancelDestinationNavigationTarget: () => viewport.singlePageScroll.cancelDestinationNavigationTarget(),
        resetZoomRerenderQueueState: reason => zoomRerenderQueue.resetZoomRerenderQueueState(reason),
        getUserViewportInteractionEpoch: () => viewport.userViewportInteractionEpoch.value,
        consumeZoomViewportAnchor: options.consumeZoomViewportAnchor,
        beginResizeTransition,
        consumeSuppressedZoomRerender,
        transactionController: viewport.transactionController,
    }).reRenderVisiblePagesAndSyncCurrentPage;

    const {
        resetRenderStallRecoveryState,
        invalidatePages,
        consumePendingInvalidation,
        handlePageRenderStall,
    } = usePdfViewerRenderStallRecovery({
        src: computed(() => documentSession.acceptedSource.value),
        isLoading: documentSession.isLoading,
        isAnySaving: options.isAnySaving,
        numPages: documentSession.numPages,
        currentPage: viewport.currentPage,
        visibleRange: viewport.visibleRange,
        viewerContainer: options.viewerContainer,
        summarizeViewerMetricsForLog: viewport.summarizeViewerMetricsForLog,
        cancelInFlightPageRenders: rendering.cancelInFlightRenders,
        renderVisiblePages,
        scheduleReload: (isReload = false) => {
            const pages = consumePendingInvalidation();
            if (pages) {
                documentSession.invalidatePagesOnNextReload(pages);
            }
            documentSession.scheduleLoad(isReload);
        },
        transactionController: viewport.transactionController,
    });

    const { scheduleRecoverInitialRender } = usePdfViewerInitialRenderRecovery({
        viewerContainer: options.viewerContainer,
        pdfDocument: documentSession.pdfDocument,
        numPages: documentSession.numPages,
        isLoading: documentSession.isLoading,
        currentPage: viewport.currentPage,
        computeFitWidthScale: viewport.scale.computeFitWidthScale,
        getVisibleRange: viewport.getVisibleRange,
        updateVisibleRange: viewport.scroll.updateVisibleRange,
        renderVisiblePages,
        syncCurrentPageFromViewport: viewport.syncCurrentPageFromViewport,
        transactionController: viewport.transactionController,
        isInitialCanvasCommitted: initialCanvasCommit.isInitialCanvasCommitted,
        isInitialVisualCommitted: initialCanvasCommit.isInitialVisualCommitted,
        onTerminalFailure: options.emitLoadError,
    });

    const {
        nextActivationRestoreRunId,
        isActivationRunCurrent,
        renderActiveDocumentAfterActivation,
    } = usePdfViewerActivationRestore({
        viewerContainer: options.viewerContainer,
        pdfDocument: documentSession.pdfDocument,
        isActive: options.isActive,
        isLoading: documentSession.isLoading,
        numPages: documentSession.numPages,
        currentPage: viewport.currentPage,
        visibleRange: viewport.visibleRange,
        viewMode: options.viewMode,
        getVisiblePageRange: viewport.scroll.getVisiblePageRange,
        updateVisibleRange: viewport.scroll.updateVisibleRange,
        scrollToPage: pageNumber => viewport.singlePageScroll.scrollToPage(pageNumber),
        renderVisiblePages,
        isPageRendered: rendering.isPageRendered,
        applySearchHighlights: rendering.applySearchHighlights,
    });

    watch(options.outputScale, (nextScale, previousScale) => {
        if (nextScale === previousScale || !documentSession.pdfDocument.value || documentSession.isLoading.value) {
            return;
        }
        if (shouldDeferPdfDprRerenderForResize(options.isResizing.value)) {
            BrowserLogger.diagnostic('pdf-nav', '[dpr-change] deferred to active layout-resize settle', {
                previousScale,
                nextScale,
            });
            return;
        }
        runGuardedTask(
            () => rendering.reRenderAllVisiblePages(() => viewport.visibleRange.value, {
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

    // ---- document transitions ----------------------------------------------

    const unsubscribeDocumentTransitions = documentSession.subscribe(async (transition) => {
        if (!transition.isCurrent()) {
            return;
        }
        if (transition.phase === 'loading') {
            pendingInitialVisualReadyToken = transition.fence.loadToken;
            initialCanvasCommit.begin(documentSession.openSurfaceGeneration);
            if (transition.plan.isSelectiveReload && transition.plan.pagesToInvalidate) {
                rendering.invalidatePages([...transition.plan.pagesToInvalidate]);
            } else if (!transition.plan.preserveVisibleContent) {
                cleanupRenderedPages();
            }
            return;
        }
        if (transition.phase === 'invalidated') {
            pendingInitialVisualReadyToken = null;
            rendering.cancelPendingSearchScroll();
            void rendering.cancelInFlightRenders();
            cleanupRenderedPages();
            zoomRerenderQueue.resetZoomRerenderQueueState(transition.reason);
            cleanupResizeLifecycle();
            return;
        }
        if (transition.phase === 'restore') {
            const runId = nextActivationRestoreRunId();
            if (!isActivationRunCurrent(runId)) {
                return;
            }
            runGuardedTask(() => renderActiveDocumentAfterActivation(runId), {
                category: 'user-visible-operation',
                scope: 'pdf-viewer',
                message: 'Failed to restore PDF rendering after tab activation',
            });
            return;
        }
        if (transition.phase === 'settled') {
            await nextTick();
            if (!transition.isCurrent()) {
                return;
            }
            rendering.applySearchHighlights();
            const loadedDocument = documentSession.pdfDocument.value;
            const viewportInteractionEpoch = viewport.userViewportInteractionEpoch.value;
            scheduleRecoverInitialRender({isCurrent: () => transition.isCurrent()
                    && documentSession.pdfDocument.value === loadedDocument
                    && viewport.userViewportInteractionEpoch.value === viewportInteractionEpoch});
            return;
        }
    });

    documentSession.registerDisposable(async () => {
        disposed = true;
        unsubscribeDocumentTransitions();
        stopDemandWatch();
        stopCancelRasterWatch();
        stopCancelSearchWatch();
        stopVisualReadyWatch();
        stopNavigationCommitWatch();
        if (frameId !== null) {
            window.cancelAnimationFrame(frameId);
            frameId = null;
        }
        clearQualityRefineIdleTimer();
        if (latestDemand.mandatoryRaster) {
            viewport.settleMandatoryRaster(latestDemand.mandatoryRaster.id);
        }
        activeMandatoryRasterId = null;
        resetRenderStallRecoveryState();
        pendingInitialVisualReadyToken = null;
        zoomRerenderQueue.cleanupZoomRerenderQueue();
        cleanupResizeLifecycle();
        cleanupRenderedPages();
        await rendering.cancelRasterDemand();
    });

    return {
        ...rendering,
        renderVisiblePages,
        renderedPageStateVersion,
        cleanupRenderedPages,
        isPageVisualReady,
        isPageRenderedForClass: isPageVisualReady,
        getPageVisualReadiness,
        isPageRenderFailed: (pageNumber: number) => getPageVisualReadiness(pageNumber) === 'error',
        clampedVisibleRefineMode: options.performancePolicy.clampedVisibleRefineMode,
        initialCanvasCommit,
        invalidatePages,
        handlePageRenderStall,
        captureZoomVisualSnapshots: () => captureResizeVisualSnapshots(buildResizeAnchorContext()),
        setZoomRerenderQueueSuppression: (targetZoom: number) => {
            suppressedZoomRerenderTarget = targetZoom;
        },
        attachAnnotationProjection(attached: IPdfAnnotationProjection) {
            projection.value = attached;
            return () => {
                if (projection.value === attached) {
                    projection.value = null;
                }
            };
        },
    };
};

export type TPdfRenderingSession = ReturnType<typeof createPdfRenderingSession>;
