import { Mutex } from 'es-toolkit/promise';
import type {
    PDFPageProxy,
    RenderTask,
} from 'pdfjs-dist';
import type {
    IPageRange,
    IPdfPageMatches,
    IPdfPageMetric,
} from '@app/types/pdfUi';
import { usePdfCanvasRenderer } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfCanvasRenderer';
import { usePdfTextLayerRenderer } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfTextLayerRenderer';
import { usePdfAnnotationLayerRenderer } from '@app/modules/pdf-viewer/runtime/rendering/usePdfAnnotationLayerRenderer';
import { setupPagePlaceholderSizes } from '@app/modules/pdf-viewer/engine/pdf-page-buffer-manager/setupPagePlaceholderSizes';
import { normalizePageMetrics } from '@app/modules/pdf-viewer/engine/pdf-page-layout/normalizePageMetrics';
import { BrowserLogger } from '@app/utils/browserLogger';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import { runGuardedTask } from '@app/utils/asyncGuard';
import { usePdfRendererSearchController } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRendererSearchController';
import { usePdfRendererPageRegistry } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRendererPageRegistry';
import { createPdfRendererPageDom } from '@app/modules/pdf-viewer/runtime/rendering/pdf-renderer-page-dom/createPdfRendererPageDom';
import { getPerformanceProfile } from '@app/utils/performanceProfile';
import { usePdfRendererCleanupController } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRendererCleanupController';
import { usePdfRendererCanvasController } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRendererCanvasController';
import { usePdfRendererAnnotationLayerController } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRendererAnnotationLayerController';
import { usePdfRendererTextLayerController } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRendererTextLayerController';
import { usePdfRendererRerenderController } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRendererRerenderController';
import { usePdfRendererSinglePageController } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRendererSinglePageController';
import { usePdfRendererVisibleRenderController } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRendererVisibleRenderController';
import { resolveHiddenEmbeddedAnnotationIdsForPageContainer } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-refresh/syncHiddenEmbeddedAnnotationDom';
import { resolvePdfRasterSourceMaxPixels } from '@app/types/pdfRasterDisplayProfile';
import type {
    IRenderVisiblePagesOptions,
    IUsePdfPageRendererOptions,
} from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';
import type { IPdfViewerTransactionRenderRequest } from '@app/modules/pdf-viewer/engine/pdf-viewer-transaction/pdfViewerTransactionTypes';
import { bindPdfOpenSurfaceRenderContext } from '@app/modules/pdf-viewer/engine/pdf-page-render-pipeline/bindPdfOpenSurfaceRenderContext';
import { isRenderingCancelledError } from '@app/modules/pdf-viewer/engine/pdf-page-render-pipeline/isRenderingCancelledError';
import {
    createPdfRenderSupervisor,
    type IArmPdfRenderSupervisorTimerOptions,
    type IPdfRenderSupervisorTimer,
} from '@app/modules/pdf-viewer/engine/pdf-render-supervisor/pdfRenderSupervisor';
import { createPdfPageLayerRevisionGraph } from '@app/modules/pdf-viewer/runtime/rendering/createPdfPageLayerRevisionGraph';
import { ensurePdfPageRasterScheduler } from '@app/modules/pdf-viewer/engine/pdf-page-raster-scheduler/pdfPageRasterScheduler';
import {
    LANE_CONTINUATION_PRIORITY,
    type IPdfRasterDemand,
    type IPdfRasterRenderTarget,
    type IPdfPageRasterScheduler,
    type TPdfRasterLane,
} from '@app/modules/pdf-viewer/engine/pdf-page-raster-scheduler/pdfPageRasterScheduler';
export type { IPageRenderStallPayload } from '@app/modules/pdf-viewer/engine/pdf-page-render-timeout/pdfPageRenderTimeoutTypes';
const PDF_VIEWPORT_RASTER_SOURCE_ID = 'pdf-viewport';
export const usePdfPageRenderer = (options: IUsePdfPageRendererOptions) => {
    const performanceProfile = getPerformanceProfile();
    const pageSlots = options.pageSlots;
    const {
        pdfDocument,
        numPages,
        basePageWidth,
        basePageHeight,
        isLoading,
        leasePage,
        evictPage,
        cleanupPageCache,
    } = options.document;
    const ensurePageMetricsInRange = 'ensurePageMetricsInRange' in options.document
        ? options.document.ensurePageMetricsInRange
        : () => Promise.resolve(false);
    const pageMetrics = 'pageMetrics' in options.document
        ? options.document.pageMetrics
        : ref<IPdfPageMetric[]>([]);

    const bufferPages = options.bufferPages ?? performanceProfile.pdfBufferPages;
    const renderConcurrency = options.renderConcurrency ?? performanceProfile.concurrentPdfRenders;
    const showAnnotations = options.showAnnotations ?? true;
    const searchPageMatches =
        options.searchPageMatches ?? new Map<number, IPdfPageMatches>();
    const currentSearchMatch = options.currentSearchMatch ?? null;
    const currentSearchMatchNavigationId = options.currentSearchMatchNavigationId ?? 0;
    const workingCopyPath = options.workingCopyPath ?? null;
    const documentRevisionToken = options.documentRevisionToken ?? null;
    const isActive = options.isActive ?? true;

    const outputScale =
        options.outputScale ??
    (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);

    const canvasRenderer = usePdfCanvasRenderer({
        outputScale,
        defaultMaxCanvasPixels: performanceProfile.settledMaxCanvasPixels,
    });
    const textLayerRenderer = usePdfTextLayerRenderer({
        searchPageMatches,
        currentSearchMatch,
        workingCopyPath,
        documentRevisionToken,
        effectiveScale: options.effectiveScale,
        viewportWritePort: options.viewportWritePort,
    });
    const renderMutex = new Mutex();
    const pageLayerRevisions = createPdfPageLayerRevisionGraph();
    const renderSupervisor = options.renderSupervisor ?? createPdfRenderSupervisor();
    const annotationLayerRenderer = usePdfAnnotationLayerRenderer({
        numPages,
        currentPage: options.currentPage,
        pdfDocument,
        showAnnotations,
        hiddenAnnotationIds: options.hiddenAnnotationIds ?? new Set<string>(),
        managedAnnotationIds: options.managedAnnotationIds ?? new Set<string>(),
        annotationUiManager: options.annotationUiManager ?? null,
        annotationL10n: options.annotationL10n ?? null,
        renderSupervisor,
        replaceAnnotationUiManager: options.replaceAnnotationUiManager,
        ...(options.scrollToPage ? { scrollToPage: options.scrollToPage } : {}),
    });

    const renderLifecycleTimerDisposers = new Set<() => boolean>();
    const missingRenderTargetWaits = new Map<number, AbortController>();
    let renderVersion = 0;
    let visibleRenderRequestId = 0;
    function getRenderDocumentToken() {
        return `${String(toValue(workingCopyPath) ?? '')}\0${String(toValue(documentRevisionToken) ?? '')}`;
    }

    function armRenderLifecycleTimer(
        timerOptions: IArmPdfRenderSupervisorTimerOptions,
        onClear?: (() => void) | undefined,
    ): IPdfRenderSupervisorTimer {
        let timer: IPdfRenderSupervisorTimer | null = null;
        let disposed = false;
        const dispose = () => {
            if (disposed) {
                return false;
            }
            disposed = true;
            renderLifecycleTimerDisposers.delete(dispose);
            const didClear = timer?.clear() ?? false;
            onClear?.();
            return didClear;
        };
        timer = renderSupervisor.armTimer({
            ...timerOptions,
            onFire: (event) => {
                if (disposed) {
                    return;
                }
                disposed = true;
                renderLifecycleTimerDisposers.delete(dispose);
                timerOptions.onFire(event);
            },
        });
        renderLifecycleTimerDisposers.add(dispose);
        return {
            key: timer.key,
            token: timer.token,
            clear: dispose,
            isCurrent: () => timer?.isCurrent() ?? false,
        };
    }

    function waitForRenderLifecycleDelay(
        timerOptions: Omit<IArmPdfRenderSupervisorTimerOptions, 'onFire'>,
    ) {
        return new Promise<boolean>((resolve) => {
            let settled = false;
            armRenderLifecycleTimer({
                ...timerOptions,
                onFire: () => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    resolve(true);
                },
            }, () => {
                if (settled) {
                    return;
                }
                settled = true;
                resolve(false);
            });
        });
    }

    function clearRenderLifecycleTimers() {
        for (const dispose of Array.from(renderLifecycleTimerDisposers)) {
            dispose();
        }
        renderLifecycleTimerDisposers.clear();
        for (const controller of missingRenderTargetWaits.values()) {
            controller.abort();
        }
        missingRenderTargetWaits.clear();
    }

    const {
        pageRenderState,
        renderedPages,
        renderingPages,
        renderingPageRequestIds,
        activeRenderTasks,
        missingRenderTargetRetries,
        pageCanvases,
        textLayerCleanupFns,
        activeTextLayerAbortControllers,
        activeOptionalTextLayerTasks,
        cancelActiveRenderTask,
        cancelActiveRenderTaskIfCurrent,
        cancelAllActiveRenderTasks,
        waitForActiveRenderTasksToSettle,
        cancelActiveTextLayerRender,
        cancelActiveTextLayerRenderIfCurrent,
        cancelAllActiveTextLayerRenders,
        trackOptionalTextLayerTask,
        waitForOptionalTextLayerTasksToSettle,
        getTrackedPageNumbersForCleanup,
    } = usePdfRendererPageRegistry();

    const {
        getMountedPageContainer,
        clearSelectionBeforePageLayerTeardown,
        summarizePageDom,
    } = createPdfRendererPageDom({
        container: options.container,
        currentPage: options.currentPage,
        renderedPages,
        renderingPages,
        renderingPageRequestIds,
        pageCanvases,
    });

    function bumpRenderVersion(
        reason = 'unspecified',
        payload?: Record<string, unknown>,
    ) {
        const previousVersion = renderVersion;
        renderVersion += 1;
        logPdfRenderTrace('renderer-version-bump', {
            reason,
            previousVersion,
            nextVersion: renderVersion,
            activeTasks: Array.from(activeRenderTasks.keys()),
            activeTextLayers: Array.from(activeTextLayerAbortControllers.keys()),
            activeOptionalTextLayers: Array.from(activeOptionalTextLayerTasks.keys()),
            renderedPages: Array.from(renderedPages),
            renderingPages: Array.from(renderingPages.entries()),
            renderingPageRequestIds: Array.from(renderingPageRequestIds.entries()),
            ...payload,
        });
        clearRenderLifecycleTimers();
        viewportDemandGeneration += 1;
        // Demand set survives cancellation: cancelSource releases consult it,
        // and the next expansion replaces it atomically.
        if (activeRasterScheduler) {
            void activeRasterScheduler.cancelSource(PDF_VIEWPORT_RASTER_SOURCE_ID);
        }
        viewportRasterJobs.clear();
        for (const pageNumber of [...viewportRasterWaiters.keys()]) {
            resolveViewportRasterWaiters(pageNumber);
        }
        canvasController.abortQueuedCanvasRenders();
        cancelAllActiveRenderTasks();
        cancelAllActiveTextLayerRenders();
        options.onRenderedPageStateChanged?.();
        return renderVersion;
    }

    function logNonCriticalStageError(
        pageNumber: number,
        stage: string,
        error: unknown,
    ) {
        if (isRenderingCancelledError(error)) {
            return;
        }
        BrowserLogger.error(
            'pdf-renderer',
            `Failed to render ${stage} for page ${pageNumber}`,
            error,
        );
    }

    function createSinglePageRetryTransactionRequest(
        pageNumber: number,
        optionsOverride: IRenderVisiblePagesOptions,
        transactionRequest: IPdfViewerTransactionRenderRequest,
    ): IPdfViewerTransactionRenderRequest {
        const range = {
            start: pageNumber,
            end: pageNumber,
        };
        return {
            ...transactionRequest,
            range,
            requiredRange: range,
            buffer: optionsOverride.bufferOverride ?? transactionRequest.buffer,
            preserveRenderedPages: optionsOverride.preserveRenderedPages
                ?? transactionRequest.preserveRenderedPages,
            preserveInFlightRequiredPages: optionsOverride.preserveInFlightRequiredPages
                ?? transactionRequest.preserveInFlightRequiredPages,
            forceRerender: optionsOverride.forceRerender ?? transactionRequest.forceRerender,
            ...(optionsOverride.renderWindowOverride
                ? { renderWindowOverride: optionsOverride.renderWindowOverride }
                : {}),
            ...(optionsOverride.prioritizeTextLayer !== undefined
                ? { prioritizeTextLayer: optionsOverride.prioritizeTextLayer }
                : {}),
        };
    }

    function scheduleRenderForSinglePage(
        pageNumber: number,
        optionsOverride: IRenderVisiblePagesOptions,
        transactionRequest?: IPdfViewerTransactionRenderRequest | undefined,
    ) {
        runGuardedTask(
            () => transactionRequest
                ? renderTransactionPages(createSinglePageRetryTransactionRequest(
                    pageNumber,
                    optionsOverride,
                    transactionRequest,
                ))
                : renderVisiblePages(
                    {
                        start: pageNumber,
                        end: pageNumber,
                    },
                    {
                        ...optionsOverride,
                        preserveInFlightRequiredPages:
                            optionsOverride.preserveInFlightRequiredPages ?? true,
                    },
                ),
            {
                category: 'user-visible-operation',
                scope: 'pdf-renderer',
                message: `Failed to schedule follow-up render for page ${pageNumber}`,
            },
        );
    }

    function scheduleMissingRenderTargetRetry(
        pageNumber: number,
        version: number,
        requestId: number,
        shouldRetry: boolean,
        visibleRange: IPageRange,
        documentToken: string,
        transactionRequest?: IPdfViewerTransactionRenderRequest | undefined,
    ) {
        const isStaleVisibleRange = options.isVisibleRenderRangeCurrent?.(visibleRange) === false;
        const isStaleTransactionRequest = transactionRequest
            ? options.isRenderRequestCurrent?.(transactionRequest) === false
            : false;
        if (
            !shouldRetry
            || renderVersion !== version
            || requestId !== visibleRenderRequestId
            || getRenderDocumentToken() !== documentToken
            || isStaleVisibleRange
            || isStaleTransactionRequest
        ) {
            if (isStaleVisibleRange) {
                missingRenderTargetRetries.delete(pageNumber);
                logPdfRenderTrace('renderer-missing-target-retry-skipped-stale-range', {
                    pageNumber,
                    version,
                    renderVersion,
                    currentPage: options.currentPage.value,
                    visibleRange,
                });
            }
            return;
        }

        if (!pageSlots) {
            if (missingRenderTargetRetries.has(pageNumber)) {
                return;
            }
            missingRenderTargetRetries.set(pageNumber, 1);
            scheduleRenderForSinglePage(pageNumber, {
                preserveRenderedPages: true,
                bufferOverride: 0,
            }, transactionRequest);
            return;
        }
        missingRenderTargetRetries.set(pageNumber, 1);
        missingRenderTargetWaits.get(pageNumber)?.abort();
        const controller = new AbortController();
        missingRenderTargetWaits.set(pageNumber, controller);
        void pageSlots.whenMounted(pageNumber, controller.signal).then(() => {
            if (missingRenderTargetWaits.get(pageNumber) !== controller) {
                return;
            }
            missingRenderTargetWaits.delete(pageNumber);
            const isRetryStaleVisibleRange = options.isVisibleRenderRangeCurrent?.(visibleRange) === false;
            const isRetryStaleTransactionRequest = transactionRequest
                ? options.isRenderRequestCurrent?.(transactionRequest) === false
                : false;
            if (
                renderVersion !== version
                || requestId !== visibleRenderRequestId
                || getRenderDocumentToken() !== documentToken
                || isRetryStaleVisibleRange
                || isRetryStaleTransactionRequest
            ) {
                if (isRetryStaleVisibleRange) {
                    missingRenderTargetRetries.delete(pageNumber);
                    logPdfRenderTrace('renderer-missing-target-retry-abort-stale-range', {
                        pageNumber,
                        version,
                        renderVersion,
                        currentPage: options.currentPage.value,
                        visibleRange,
                    });
                }
                return;
            }

            scheduleRenderForSinglePage(pageNumber, {
                preserveRenderedPages: true,
                bufferOverride: 0,
            }, transactionRequest);
        }).catch((error: unknown) => {
            if (!(error instanceof DOMException && error.name === 'AbortError')) {
                BrowserLogger.error('pdf-renderer', `Failed waiting for page ${pageNumber} slot`, error);
            }
        });
    }

    function resolveCanvasHiddenAnnotationIds(pageNumber: number) {
        const hiddenAnnotationIds = toValue(options.canvasHiddenAnnotationIds ?? options.hiddenAnnotationIds);
        const pageContainer = getMountedPageContainer(pageNumber, options.container.value);
        const hasPageContainer = Boolean(pageContainer);
        if (!hiddenAnnotationIds || hiddenAnnotationIds.size === 0) {
            logPdfRenderTrace('renderer-page-hidden-annotations-resolved', {
                pageNumber,
                baseHiddenAnnotationCount: hiddenAnnotationIds?.size ?? 0,
                resolvedHiddenAnnotationCount: hiddenAnnotationIds?.size ?? 0,
                managedAnnotationCount: toValue(options.managedAnnotationIds)?.size ?? 0,
                hasPageContainer,
            });
            return hiddenAnnotationIds;
        }

        const resolvedHiddenAnnotationIds = resolveHiddenEmbeddedAnnotationIdsForPageContainer({
            hiddenAnnotationIds,
            managedAnnotationIds: toValue(options.managedAnnotationIds),
            pageContainer,
        });
        logPdfRenderTrace('renderer-page-hidden-annotations-resolved', {
            pageNumber,
            baseHiddenAnnotationCount: hiddenAnnotationIds.size,
            resolvedHiddenAnnotationCount: resolvedHiddenAnnotationIds.size,
            managedAnnotationCount: toValue(options.managedAnnotationIds)?.size ?? 0,
            hasPageContainer,
            baseHiddenAnnotationIds: Array.from(hiddenAnnotationIds).slice(0, 30),
            resolvedHiddenAnnotationIds: Array.from(resolvedHiddenAnnotationIds).slice(0, 30),
        });
        return resolvedHiddenAnnotationIds;
    }

    const searchController = usePdfRendererSearchController({
        container: options.container,
        isActive,
        isLoading,
        numPages,
        textLayerRenderer,
        searchPageMatches,
        currentSearchMatch,
        currentSearchMatchNavigationId,
        scheduleRenderForSinglePage: (pageNumber) => {
            scheduleRenderForSinglePage(pageNumber, {
                preserveRenderedPages: true,
                bufferOverride: 0,
                prioritizeTextLayer: true,
            });
        },
        ...(options.scrollToPage ? { scrollToPage: options.scrollToPage } : {}),
        ...(options.suppressSnap ? { suppressSnap: options.suppressSnap } : {}),
        ...(options.beginSearchNavigation ? { beginSearchNavigation: options.beginSearchNavigation } : {}),
        ...(options.revealSearchNavigationTarget ? { revealSearchNavigationTarget: options.revealSearchNavigationTarget } : {}),
        ...(options.endSearchNavigation ? { endSearchNavigation: options.endSearchNavigation } : {}),
        ...(options.beginSearchTransaction ? { beginSearchTransaction: options.beginSearchTransaction } : {}),
        ...(options.isSearchTransactionCurrent ? { isSearchTransactionCurrent: options.isSearchTransactionCurrent } : {}),
        ...(options.settleSearchTransaction ? { settleSearchTransaction: options.settleSearchTransaction } : {}),
        ...(options.cancelSearchTransaction ? { cancelSearchTransaction: options.cancelSearchTransaction } : {}),
        isPageRenderPending: (pageNumber) => (
            renderingPages.has(pageNumber)
            || activeRenderTasks.has(pageNumber)
            || activeTextLayerAbortControllers.has(pageNumber)
        ),
    });

    const {
        cleanupTextLayer,
        clearPageVisual,
        cleanupPage,
        cleanupPageIfCurrentRender,
        cleanupAllPages: cleanupAllPagesSync,
    } = usePdfRendererCleanupController({
        container: options.container,
        currentPage: options.currentPage,
        pageRenderState,
        renderedPages,
        renderingPages,
        renderingPageRequestIds,
        missingRenderTargetRetries,
        pageCanvases,
        textLayerCleanupFns,
        canvasRenderer,
        textLayerRenderer,
        annotationLayerRenderer,
        getRenderVersion: () => renderVersion,
        bumpRenderVersion,
        getMountedPageContainer,
        summarizePageDom,
        cancelActiveRenderTask,
        cancelActiveTextLayerRender,
        getTrackedPageNumbersForCleanup,
        evictPage,
        cleanupPageCache,
        onRenderedPageStateChanged: options.onRenderedPageStateChanged,
        invalidatePendingSearchRequests: searchController.invalidatePendingRequests,
    });
    const canvasController = usePdfRendererCanvasController({
        canvasRenderer,
        activeRenderTasks,
        pageCanvases,
        hiddenAnnotationIds: pageNumber => resolveCanvasHiddenAnnotationIds(pageNumber),
        sourceMaxPixels: pageNumber => resolvePdfRasterSourceMaxPixels(
            toValue(options.rasterDisplayProfile) ?? null,
            pageNumber,
        ),
        getRenderVersion: () => renderVersion,
        getPage: leasePage,
        cancelActiveRenderTask,
        cancelActiveRenderTaskIfCurrent,
        onRenderStall: options.onRenderStall,
    });
    const {
        loadPageForRender,
        prepareCanvasRenderForPage,
        renderPreparedCanvasForPage,
        prepareCanvasForRender,
        mountRenderedCanvas,
    } = canvasController;
    type TCanvasRenderResult = NonNullable<Awaited<ReturnType<typeof prepareCanvasForRender>>>;
    const renderAnnotationLayersForPage = usePdfRendererAnnotationLayerController({
        annotationLayerRenderer,
        showAnnotations,
        annotationUiManager: options.annotationUiManager ?? null,
        getRenderVersion: () => renderVersion,
        cleanupPageIfCurrentRender,
        logNonCriticalStageError,
        renderSupervisor,
        onAnnotationLayersRendered: options.onAnnotationLayersRendered,
    });
    const renderTextLayerForPage = usePdfRendererTextLayerController({
        textLayerRenderer,
        activeTextLayerAbortControllers,
        textLayerCleanupFns,
        getRenderVersion: () => renderVersion,
        cleanupTextLayer,
        cleanupPageIfCurrentRender,
        cancelActiveTextLayerRender,
        cancelActiveTextLayerRenderIfCurrent,
        clearSelectionBeforePageLayerTeardown,
        logNonCriticalStageError,
    });
    const {
        renderSingleVisiblePage,
        renderAnnotationEditorLayerForPage,
    } = usePdfRendererSinglePageController<TCanvasRenderResult>({
        isActive,
        effectiveScale: options.effectiveScale,
        outputScale,
        annotationUiManager: options.annotationUiManager ?? null,
        getContainerRoot: () => options.container.value,
        pageRenderState,
        renderingPages,
        renderingPageRequestIds,
        activeRenderTasks,
        getRenderVersion: () => renderVersion,
        getRenderDocumentToken,
        getDocumentRevision: () => String(toValue(documentRevisionToken) ?? ''),
        getVisibleRenderRequestId: () => visibleRenderRequestId,
        summarizePageDom,
        clearSelectionBeforePageLayerTeardown,
        clearPageVisual,
        trackOptionalTextLayerTask,
        cleanupPageIfCurrentRender,
        cleanupCanvasRenderResult: canvasRenderer.cleanupCanvasRenderResult,
        loadPageForRender,
        prepareCanvasRenderForPage,
        renderPreparedCanvasForPage,
        prepareCanvasForRender,
        applyContainerUserUnit: (container, renderResult) => {
            canvasRenderer.applyContainerUserUnit(
                container,
                renderResult.userUnit,
            );
        },
        mountRenderedCanvas,
        scheduleRenderForSinglePage,
        scheduleMissingRenderTargetRetry,
        clearMissingRenderTargetRetry: (pageNumber) => {
            missingRenderTargetWaits.get(pageNumber)?.abort();
            missingRenderTargetWaits.delete(pageNumber);
            missingRenderTargetRetries.delete(pageNumber);
        },
        waitForRenderLifecycleDelay,
        renderTextLayerForPage,
        renderAnnotationLayersForPage,
        renderAnnotationEditorLayer: annotationLayerRenderer.renderAnnotationEditorLayer,
        getViewportForAnnotationEditorLayer: (pdfPage, scale) => pdfPage.getViewport({ scale }),
        scheduleOcrDebugForPage: (pageNumber, context) => {
            textLayerRenderer.scheduleOcrDebugForPage?.(pageNumber, context);
        },
        onPageCanvasMounted: (commit) => {
            const pageNumber = commit.pageNumber;
            if (hasNonzeroMountedPageCanvas(pageNumber)) {
                options.onRenderedPageStateChanged?.();
            }
            options.onPageCanvasMounted?.(commit);
        },
        onPageRendered: options.onPageRendered,
        onRenderedPageStateChanged: options.onRenderedPageStateChanged,
        logNonCriticalStageError,
        renderSupervisor,
    });

    function setupPagePlaceholders() {
        const containerRoot = options.container.value;
        const baseWidth = toValue(basePageWidth);
        const baseHeight = toValue(basePageHeight);
        if (!containerRoot || !baseWidth || !baseHeight) {
            return;
        }

        const scale = toValue(options.effectiveScale);
        const normalizedPageMetrics = normalizePageMetrics({
            pageMetrics: pageMetrics.value,
            totalPages: numPages.value,
            fallbackWidth: baseWidth,
            fallbackHeight: baseHeight,
        });
        setupPagePlaceholderSizes(containerRoot, normalizedPageMetrics, scale);
    }

    interface IViewportRasterJob {
        demand: IPdfRasterDemand;
        forceRerender: boolean;
        renderOptions: IRenderVisiblePagesOptions;
        version: number;
        visibleRange: IPageRange;
    }

    interface IPreparedViewportRaster {
        job: IViewportRasterJob;
        page: PDFPageProxy;
    }

    const viewportRasterJobs = new Map<string, IViewportRasterJob>();
    const viewportRasterWaiters = new Map<number, Set<() => void>>();
    const currentViewportDemandPages = new Set<number>();
    let activeRasterScheduler: IPdfPageRasterScheduler | null = null;
    let viewportDemandGeneration = 0;

    function resolveViewportRasterWaiters(pageNumber: number) {
        const waiters = viewportRasterWaiters.get(pageNumber);
        if (!waiters) {
            return;
        }
        viewportRasterWaiters.delete(pageNumber);
        for (const resolve of waiters) {
            resolve();
        }
    }

    function waitForViewportRaster(pageNumber: number, forceWait = false) {
        if (!forceWait && isCommittedVisualCurrent(pageNumber)) {
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
            const waiters = viewportRasterWaiters.get(pageNumber) ?? new Set();
            waiters.add(resolve);
            viewportRasterWaiters.set(pageNumber, waiters);
        });
    }

    const viewportRasterTarget: IPdfRasterRenderTarget<IPreparedViewportRaster> = {
        id: 'pdf-viewport',
        prepare(demand, page) {
            const job = viewportRasterJobs.get(demand.renderKey);
            if (
                !job
                || job.version !== renderVersion
                || pdfDocument.value === null
            ) {
                return Promise.resolve(null);
            }
            return Promise.resolve({
                job,
                page,
            });
        },
        start(prepared) {
            const {
                demand,
                forceRerender,
                renderOptions,
                version,
                visibleRange,
            } = prepared.job;
            const controller = new AbortController();
            let continuation: RenderTask['onContinue'];
            let activeTask: RenderTask | null = null;
            const requestId = ++visibleRenderRequestId;
            const taskBridge = {bind(task: RenderTask) {
                activeTask = task;
                task.onContinue = continuation;
            }};
            const shouldContinue = () => (
                !controller.signal.aborted
                && renderVersion === version
                && pdfDocument.value !== null
            );
            const promise = (async () => {
                if (!shouldContinue()) {
                    return;
                }
                const containerRoot = options.container.value;
                if (!containerRoot) {
                    return;
                }
                await renderSingleVisiblePage(
                    containerRoot,
                    demand.pageNumber,
                    version,
                    toValue(options.effectiveScale),
                    forceRerender,
                    requestId,
                    shouldContinue,
                    new Set([demand.pageNumber]),
                    visibleRange,
                    {
                        ...renderOptions,
                        // Mounted committed canvases persist until the
                        // replacement is ready (quality-refine path).
                        preserveCommittedVisual: renderOptions?.preserveCommittedVisual === true
                            || isCommittedVisualCurrent(demand.pageNumber),
                        continuationPriority: LANE_CONTINUATION_PRIORITY[demand.lane],
                        rasterSchedulerTaskBridge: taskBridge,
                        rasterSchedulerPage: prepared.page,
                    },
                );
            })();
            return {
                cancel() {
                    controller.abort();
                    activeTask?.cancel();
                    cancelActiveRenderTaskIfCurrent(
                        demand.pageNumber,
                        version,
                        requestId,
                    );
                },
                promise,
                get onContinue() {
                    return continuation;
                },
                set onContinue(next: RenderTask['onContinue']) {
                    continuation = next;
                    if (activeTask) {
                        activeTask.onContinue = next;
                    }
                },
            } as RenderTask;
        },
        commit(prepared) {
            const pageNumber = prepared.job.demand.pageNumber;
            resolveViewportRasterWaiters(pageNumber);
            return isCommittedVisualCurrent(pageNumber);
        },
        discard(prepared) {
            resolveViewportRasterWaiters(prepared.job.demand.pageNumber);
        },
        release(pageNumber) {
            resolveViewportRasterWaiters(pageNumber);
            if (!currentViewportDemandPages.has(pageNumber)) {
                cleanupPage(pageNumber);
            }
        },
    };

    const renderLayerPromotions = usePdfRendererVisibleRenderController({
        container: options.container,
        effectiveScale: options.effectiveScale,
        isActive,
        numPages,
        renderConcurrency,
        ensurePageMetricsInRange,
        getRenderVersion: () => renderVersion,
        nextRequestId: (requested) => {
            visibleRenderRequestId = requested ?? visibleRenderRequestId + 1;
            return visibleRenderRequestId;
        },
        setupPagePlaceholders,
        isRenderRequestCurrent: options.isRenderRequestCurrent,
        isVisibleRenderRangeCurrent: options.isVisibleRenderRangeCurrent,
        renderSingleVisiblePage,
    });

    function resolveViewportRasterLane(
        pageNumber: number,
        visibleRange: IPageRange,
        renderOptions: IRenderVisiblePagesOptions,
    ): TPdfRasterLane {
        if (
            renderOptions.transactionRequest?.priority === 'authoritative'
            && pageNumber >= visibleRange.start
            && pageNumber <= visibleRange.end
        ) {
            return 'navigation-target';
        }
        if (pageNumber >= visibleRange.start && pageNumber <= visibleRange.end) {
            return 'viewport-visible';
        }
        const distance = pageNumber < visibleRange.start
            ? visibleRange.start - pageNumber
            : pageNumber - visibleRange.end;
        return distance <= 1 ? 'viewport-nearby' : 'prefetch';
    }

    function buildViewportRasterJobs(
        visibleRange: IPageRange,
        renderOptions: IRenderVisiblePagesOptions,
        scheduler: IPdfPageRasterScheduler,
    ) {
        const buffer = renderOptions.bufferOverride ?? toValue(bufferPages);
        const override = renderOptions.renderWindowOverride;
        const start = Math.max(
            1,
            Math.min(
                visibleRange.start,
                visibleRange.start - buffer,
                override?.start ?? visibleRange.start,
            ),
        );
        const end = Math.min(
            numPages.value,
            Math.max(
                visibleRange.end,
                visibleRange.end + buffer,
                override?.end ?? visibleRange.end,
            ),
        );
        const scale = toValue(options.effectiveScale);
        const pixelRatio = toValue(outputScale);
        const forceRerender = renderOptions.forceRerender === true;
        const jobs: IViewportRasterJob[] = [];
        for (let pageNumber = start; pageNumber <= end; pageNumber += 1) {
            if (
                renderOptions.rasterDemandPages
                && !renderOptions.rasterDemandPages.includes(pageNumber)
            ) {
                continue;
            }
            const metric = pageMetrics.value[pageNumber - 1];
            const width = metric?.width ?? toValue(basePageWidth) ?? 1;
            const height = metric?.height ?? toValue(basePageHeight) ?? 1;
            const requestedPixels = Math.max(1, Math.ceil(width * scale * pixelRatio))
                * Math.max(1, Math.ceil(height * scale * pixelRatio));
            const lane = resolveViewportRasterLane(
                pageNumber,
                visibleRange,
                renderOptions,
            );
            const pageRenderOptions = lane === 'viewport-nearby' || lane === 'prefetch'
                ? {
                    ...renderOptions,
                    contentIntent: 'canvas-only-buffer' as const,
                    preserveRenderedPages: true,
                    ...(renderOptions.bufferMaxCanvasPixels
                        ?? renderOptions.maxCanvasPixels
                        ? {maxCanvasPixels: renderOptions.bufferMaxCanvasPixels
                                ?? renderOptions.maxCanvasPixels!}
                        : {}),
                }
                : renderOptions;
            const demand: IPdfRasterDemand = {
                consumerGeneration: renderVersion,
                documentFence: scheduler.documentFence,
                estimatedPixels: Math.min(
                    requestedPixels,
                    renderOptions.maxCanvasPixels
                        ?? performanceProfile.settledMaxCanvasPixels,
                ),
                lane,
                ordinal: lane === 'viewport-visible' || lane === 'navigation-target'
                    ? pageNumber - visibleRange.start
                    : Math.min(
                        Math.abs(pageNumber - visibleRange.start),
                        Math.abs(pageNumber - visibleRange.end),
                    ),
                pageNumber,
                renderKey: [
                    renderVersion,
                    pageNumber,
                    scale,
                    pixelRatio,
                    getRenderDocumentToken(),
                    pageLayerRevisions.key(pageNumber, 'base'),
                    pageLayerRevisions.key(pageNumber, 'annotations'),
                    pageRenderOptions.contentIntent ?? 'full-visible',
                    pageRenderOptions.maxCanvasPixels ?? '',
                    pageRenderOptions.openSurfaceGeneration ?? '',
                    pageRenderOptions.openSurfaceRevision ?? '',
                ].join(':'),
                retention: 'render-cache',
            };
            const job = {
                demand,
                forceRerender,
                renderOptions: pageRenderOptions,
                version: renderVersion,
                visibleRange,
            };
            viewportRasterJobs.set(demand.renderKey, job);
            jobs.push(job);
        }
        return jobs;
    }

    async function renderVisiblePages(
        range: IPageRange,
        requestedRenderOptions?: IRenderVisiblePagesOptions,
    ) {
        const resolvedRenderOptions = bindPdfOpenSurfaceRenderContext(
            requestedRenderOptions,
            options.resolveOpenSurfaceRenderContext?.(),
        ) ?? {};
        if (resolvedRenderOptions.contentIntent === 'layers-only-promotion') {
            return renderLayerPromotions(range, resolvedRenderOptions);
        }
        const document = pdfDocument.value;
        if (!document || !toValue(isActive)) {
            return;
        }
        const demandGeneration = ++viewportDemandGeneration;
        const didHydrateMetrics = await ensurePageMetricsInRange(
            range.start,
            range.end,
        );
        if (
            demandGeneration !== viewportDemandGeneration
            || document !== pdfDocument.value
            || !toValue(isActive)
        ) {
            return;
        }
        if (didHydrateMetrics) {
            setupPagePlaceholders();
        }
        const scheduler = ensurePdfPageRasterScheduler(document, {
            documentVersion:
                'getRenderVersion' in options.document
                && typeof options.document.getRenderVersion === 'function'
                    ? options.document.getRenderVersion()
                    : renderVersion,
            leasePage,
        });
        activeRasterScheduler = scheduler;
        const jobs = buildViewportRasterJobs(
            range,
            resolvedRenderOptions,
            scheduler,
        );
        currentViewportDemandPages.clear();
        jobs.forEach(job => currentViewportDemandPages.add(job.demand.pageNumber));
        const jobsRequiringRaster = jobs.filter(job => (
            job.forceRerender
            || !isCommittedVisualCurrent(job.demand.pageNumber)
        ));
        for (const job of jobsRequiringRaster) {
            scheduler.invalidate({
                pages: [job.demand.pageNumber],
                reason: 'viewport-raster-repair-or-replacement',
                sourceId: PDF_VIEWPORT_RASTER_SOURCE_ID,
            });
        }
        const rasterWaits = jobsRequiringRaster.map(job =>
            waitForViewportRaster(job.demand.pageNumber, true));
        const navigationJobs = jobs.filter(
            job => job.demand.lane === 'navigation-target',
        );
        if (navigationJobs.length > 0) {
            await Promise.all(navigationJobs.map(job => scheduler.request({
                sourceId: PDF_VIEWPORT_RASTER_SOURCE_ID,
                demand: job.demand,
                target: viewportRasterTarget,
            })));
            return;
        }
        scheduler.setDemand({
            sourceId: PDF_VIEWPORT_RASTER_SOURCE_ID,
            input: jobs.map(job => job.demand),
            policy: {
                expand: input => input,
                compareWithinLane: (left, right) => left.ordinal - right.ordinal,
            },
            target: viewportRasterTarget,
        });
        await Promise.all(rasterWaits);
    }

    function hasNonzeroMountedPageCanvas(pageNumber: number) {
        const pageContainer = getMountedPageContainer(pageNumber, options.container.value);
        const canvas = pageContainer?.querySelector<HTMLCanvasElement>('.page_canvas canvas');
        return Boolean(canvas && canvas.isConnected && canvas.width > 0 && canvas.height > 0);
    }

    function getPageContentReadiness(pageNumber: number, container: HTMLElement) {
        const slot = pageRenderState.getSlot(pageNumber);
        const currentScale = toValue(options.effectiveScale);
        const currentOutputScale = toValue(outputScale);
        const scaleTolerance = Math.max(1, Math.abs(currentScale)) * Number.EPSILON * 8;
        const outputScaleTolerance = Math.max(1, Math.abs(currentOutputScale)) * Number.EPSILON * 8;
        const canvasReady = slot.canvasReadiness === 'ready'
            && slot.documentToken === getRenderDocumentToken()
            && slot.contentVersion === renderVersion
            && slot.container === container
            && slot.targetScale !== null
            && Math.abs(slot.targetScale - currentScale) <= scaleTolerance
            && slot.targetOutputScale !== null
            && Math.abs(slot.targetOutputScale - currentOutputScale) <= outputScaleTolerance
            && hasNonzeroMountedPageCanvas(pageNumber);
        return {
            canvasReady,
            layerReadiness: canvasReady ? slot.layerReadiness : 'none',
        } as const;
    }

    function isCommittedVisualCurrent(pageNumber: number) {
        const container = getMountedPageContainer(pageNumber, options.container.value);
        return container
            ? getPageContentReadiness(pageNumber, container).canvasReady
            : false;
    }

    function renderTransactionPages(request: IPdfViewerTransactionRenderRequest) {
        return renderVisiblePages(request.range, {
            bufferOverride: request.buffer,
            forceRerender: request.forceRerender,
            preserveInFlightRequiredPages: request.preserveInFlightRequiredPages,
            preserveRenderedPages: request.preserveRenderedPages,
            transactionRequest: request,
            ...(request.prioritizeTextLayer !== undefined
                ? {prioritizeTextLayer: request.prioritizeTextLayer}
                : {}),
            ...(request.renderWindowOverride
                ? {renderWindowOverride: request.renderWindowOverride}
                : {}),
        });
    }

    const reRenderAllVisiblePages = usePdfRendererRerenderController({
        isActive,
        renderMutex,
        getRenderVersion: () => renderVersion,
        bumpRenderVersion,
        setupPagePlaceholders,
        renderVisiblePages,
        requestMandatoryRender: options.requestMandatoryRender,
        getTrackedPageNumbersForCleanup,
        clearPageVisual,
    });

    const { applySearchHighlights } = searchController;

    function invalidatePages(pages: number[]) {
        logPdfRenderTrace('renderer-invalidate-pages', {
            pages,
            currentPage: options.currentPage.value,
            visiblePages: pages.map(pageNumber => summarizePageDom(pageNumber)),
        });
        activeRasterScheduler?.invalidate({
            pages,
            reason: 'viewport-pages-invalidated',
            sourceId: PDF_VIEWPORT_RASTER_SOURCE_ID,
        });
        for (const pageNumber of pages) {
            pageLayerRevisions.bump(pageNumber, 'annotations');
            cancelActiveRenderTask(pageNumber);
            cancelActiveTextLayerRender(pageNumber);
            renderingPages.delete(pageNumber);
            renderingPageRequestIds.delete(pageNumber);
            clearPageVisual(pageNumber, false);
        }
        options.onRenderedPageStateChanged?.();
    }

    function cancelInFlightRenders() {
        const rasterDemandCancelled = activeRasterScheduler?.cancelSource(
            PDF_VIEWPORT_RASTER_SOURCE_ID,
        ) ?? Promise.resolve();
        const activeRenderTasksSettled = waitForActiveRenderTasksToSettle();
        const optionalTextLayerTasksSettled = waitForOptionalTextLayerTasksToSettle();
        const nextRenderVersion = bumpRenderVersion('cancel-in-flight-renders');
        for (const pageNumber of renderedPages) {
            const slot = pageRenderState.getSlot(pageNumber);
            if (
                pageRenderState.adoptCommittedCanvasVersion(pageNumber, nextRenderVersion)
                && slot.layerReadiness === 'hydrating'
            ) {
                const container = getMountedPageContainer(pageNumber, options.container.value);
                if (container) {
                    container.dataset.pageLayerReadiness = 'canvas-only';
                }
            }
        }
        missingRenderTargetRetries.clear();
        return Promise.all([
            rasterDemandCancelled,
            activeRenderTasksSettled,
            optionalTextLayerTasksSettled,
        ]).then(() => undefined);
    }

    function cleanupAllPages() {
        const optionalTextLayerTasksSettled = waitForOptionalTextLayerTasksToSettle();
        cleanupAllPagesSync();
        return optionalTextLayerTasksSettled;
    }

    const { requestScrollToCurrentResult } = searchController;

    return {
        setupPagePlaceholders,
        renderVisiblePages,
        renderTransactionPages,
        reRenderAllVisiblePages,
        cleanupAllPages,
        releaseUnmountedPage: cleanupPage,
        invalidatePages,
        applySearchHighlights,
        hideManagedAnnotationEditors: (pageNumber?: number) => {
            annotationLayerRenderer.hideHiddenManagedEditors(pageNumber);
        },
        isPageRendered: (pageNumber: number) => pageRenderState.getSlot(pageNumber).canvasReadiness === 'ready',
        isPageFreshlyRendered: (pageNumber: number) => pageRenderState.getSlot(pageNumber).canvasReadiness === 'ready',
        isPageCanvasCommitted: isCommittedVisualCurrent,
        isPageQualityRefineEligible: (pageNumber: number) => {
            const slot = pageRenderState.getSlot(pageNumber);
            return isCommittedVisualCurrent(pageNumber)
                && slot.job === 'idle'
                && slot.committedRasterQuality?.wasClamped === true
                && slot.committedRasterQuality.intent === 'buffer-preview';
        },
        isPageLayerReady: (pageNumber: number) => {
            const container = getMountedPageContainer(pageNumber, options.container.value);
            return container
                ? getPageContentReadiness(pageNumber, container).layerReadiness === 'ready'
                : false;
        },
        getCommittedRasterQuality: (pageNumber: number) => (
            pageRenderState.getSlot(pageNumber).committedRasterQuality
        ),
        isPageRendering: (pageNumber: number) => pageRenderState.getSlot(pageNumber).job === 'rendering',
        isPageRenderFailed: (pageNumber: number) => {
            const slot = pageRenderState.getSlot(pageNumber);
            return slot.job === 'failed' && slot.version === renderVersion;
        },
        getPageRenderFailureToken: (pageNumber: number) => {
            const slot = pageRenderState.getSlot(pageNumber);
            return slot.job === 'failed'
                && slot.version === renderVersion
                && slot.requestId !== null
                ? `${String(slot.version)}:${String(slot.requestId)}`
                : null;
        },
        getRenderAuthorityCursor: () => ({
            renderVersion,
            requestId: visibleRenderRequestId,
        }),
        cancelRasterDemand: () => {
            currentViewportDemandPages.clear();
            return activeRasterScheduler?.cancelSource(PDF_VIEWPORT_RASTER_SOURCE_ID)
                ?? Promise.resolve();
        },
        getRasterSchedulerSnapshot: () => activeRasterScheduler?.snapshot() ?? null,
        requestScrollToCurrentResult,
        cancelPendingSearchScroll: searchController.invalidatePendingRequests,
        cancelInFlightRenders,
        renderAnnotationEditorLayerForPage,
    };
};
