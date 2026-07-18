import { Mutex } from 'es-toolkit/promise';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type {
    IPageRange,
    IPdfPageMatches,
    IPdfPageMetric,
    IPdfSearchMatch,
} from '@app/types/pdfUi';
import type { IPdfjsL10n } from '@app/types/pdfjs';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type {
    MaybeRefOrGetter,
    Ref,
} from 'vue';
import type { usePdfDocument } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfDocument';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';
import { usePdfCanvasRenderer } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfCanvasRenderer';
import { usePdfTextLayerRenderer } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfTextLayerRenderer';
import { usePdfAnnotationLayerRenderer } from '@app/modules/pdf-viewer/runtime/rendering/usePdfAnnotationLayerRenderer';
import { setupPagePlaceholderSizes } from '@app/modules/pdf-viewer/engine/pdf-page-buffer-manager/setupPagePlaceholderSizes';
import { normalizePageMetrics } from '@app/modules/pdf-viewer/engine/pdf-page-layout/normalizePageMetrics';
import { BrowserLogger } from '@app/utils/browserLogger';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import { runGuardedTask } from '@app/utils/asyncGuard';
import type { IPageRenderStallPayload } from '@app/modules/pdf-viewer/engine/pdf-page-render-timeout/pdfPageRenderTimeoutTypes';
import { usePdfRendererSearchController } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRendererSearchController';
import { usePdfRendererPageRegistry } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRendererPageRegistry';
import { createPdfRendererPageDom } from '@app/modules/pdf-viewer/runtime/rendering/pdf-renderer-page-dom/createPdfRendererPageDom';
import { getPerformanceProfile } from '@app/utils/performanceProfile';
import { usePdfRendererCleanupController } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRendererCleanupController';
import { usePdfRendererCanvasController } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRendererCanvasController';
import { usePdfRendererAnnotationLayerController } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRendererAnnotationLayerController';
import { usePdfRendererTextLayerController } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRendererTextLayerController';
import { usePdfRendererRerenderController } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRendererRerenderController';
import { usePdfRendererVisibleRenderController } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRendererVisibleRenderController';
import { usePdfRendererSinglePageController } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRendererSinglePageController';
import { resolveHiddenEmbeddedAnnotationIdsForPageContainer } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-refresh/syncHiddenEmbeddedAnnotationDom';
import type { TPdfRasterDisplayProfile } from '@app/types/pdfRasterDisplayProfile';
import { resolvePdfRasterSourceMaxPixels } from '@app/types/pdfRasterDisplayProfile';
import type {
    IPdfCanvasDomCommit,
    IRenderVisiblePagesOptions,
} from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';
import type { IPdfViewerTransactionRenderRequest } from '@app/modules/pdf-viewer/engine/pdf-viewer-transaction/pdfViewerTransactionTypes';
import { bindPdfOpenSurfaceRenderContext } from '@app/modules/pdf-viewer/engine/pdf-page-render-pipeline/bindPdfOpenSurfaceRenderContext';
import {
    createPdfRenderSupervisor,
    type IArmPdfRenderSupervisorTimerOptions,
    type IPdfRenderSupervisorTimer,
    type IPdfRenderSupervisor,
} from '@app/modules/pdf-viewer/engine/pdf-render-supervisor/pdfRenderSupervisor';
import type {IPdfPageSlotRegistry} from '@app/modules/pdf-viewer/runtime/page-slots/pdfPageSlotRegistry';
import { createPdfPageLayerRevisionGraph } from '@app/modules/pdf-viewer/runtime/rendering/createPdfPageLayerRevisionGraph';
import type { IPdfViewportWritePort } from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportWritePort';

export type { IPageRenderStallPayload } from '@app/modules/pdf-viewer/engine/pdf-page-render-timeout/pdfPageRenderTimeoutTypes';

export interface IUsePdfPageRendererOptions {
    container: Ref<HTMLElement | null>;
    document: ReturnType<typeof usePdfDocument>;
    currentPage: Ref<number>;
    isActive?: MaybeRefOrGetter<boolean>;
    effectiveScale: MaybeRefOrGetter<number>;

    bufferPages?: MaybeRefOrGetter<number>;
    renderConcurrency?: MaybeRefOrGetter<number>;
    showAnnotations?: MaybeRefOrGetter<boolean>;
    hiddenAnnotationIds?: MaybeRefOrGetter<Set<string>>;
    canvasHiddenAnnotationIds?: MaybeRefOrGetter<Set<string>> | undefined;
    managedAnnotationIds?: MaybeRefOrGetter<Set<string>>;
    scrollToPage?: (
        pageNumber: number,
        options?: IScrollToPageOptions,
    ) => void;
    suppressSnap?: () => void;
    beginSearchNavigation?: (pageNumber: number) => void;
    revealSearchNavigationTarget?: (
        pageNumber: number,
        options?: Pick<IScrollToPageOptions, 'markerRect'>,
    ) => void;
    endSearchNavigation?: (settleMs?: number) => void;
    beginSearchTransaction?: (
        pageNumber: number,
        options?: Pick<IScrollToPageOptions, 'markerRect'>,
    ) => number | null;
    isSearchTransactionCurrent?: (transactionId: number) => boolean;
    settleSearchTransaction?: (transactionId: number) => void;
    cancelSearchTransaction?: (transactionId: number) => void;
    outputScale?: MaybeRefOrGetter<number>;
    rasterDisplayProfile?: MaybeRefOrGetter<TPdfRasterDisplayProfile | null>;

    annotationUiManager?: MaybeRefOrGetter<AnnotationEditorUIManager | null>;
    annotationL10n?: MaybeRefOrGetter<IPdfjsL10n | null>;
    replaceAnnotationUiManager?: ((manager: AnnotationEditorUIManager) => void) | undefined;

    searchPageMatches?: MaybeRefOrGetter<Map<number, IPdfPageMatches>>;
    currentSearchMatch?: MaybeRefOrGetter<IPdfSearchMatch | null>;
    currentSearchMatchNavigationId?: MaybeRefOrGetter<number>;

    workingCopyPath?: MaybeRefOrGetter<TDocumentRef | null>;
    documentRevisionToken?: MaybeRefOrGetter<TDocumentRevisionToken | null>;
    onRenderStall?: (payload: IPageRenderStallPayload) => void;
    onPageRendered?: (pageNumber: number) => void;
    onPageCanvasMounted?: (commit: IPdfCanvasDomCommit) => void;
    resolveOpenSurfaceRenderContext?: (() => {
        openSurfaceGeneration: number;
        openSurfaceRevision: string;
    }) | undefined;
    isVisibleRenderRangeCurrent?: ((visibleRange: IPageRange) => boolean) | undefined;
    getProtectedVisibleRange?: (() => IPageRange) | undefined;
    isRenderRequestCurrent?: ((request: IPdfViewerTransactionRenderRequest) => boolean) | undefined;
    onAnnotationLayersRendered?: ((pageNumber: number, container: HTMLElement) => void) | undefined;
    onRenderedPageStateChanged?: () => void;
    renderSupervisor?: IPdfRenderSupervisor | undefined;
    pageSlots?: IPdfPageSlotRegistry | undefined;
    requestMandatoryRender?: ((
        visibleRange: IPageRange,
        options?: IRenderVisiblePagesOptions,
    ) => Promise<void>) | undefined;
    viewportWritePort: IPdfViewportWritePort;
}

export const usePdfPageRenderer = (options: IUsePdfPageRendererOptions) => {
    const performanceProfile = getPerformanceProfile();
    const pageSlots = options.pageSlots;
    let handlePageSurfaceEvicted = (_pageNumber: number) => {
        options.onRenderedPageStateChanged?.();
    };
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
    const RERENDER_LOG_THROTTLE_MS = 420;
    let renderVersion = 0;
    let visibleRenderRequestId = 0;
    function getProtectedVisibleRange() {
        const requestedRange = options.getProtectedVisibleRange?.();
        if (
            requestedRange
            && Number.isFinite(requestedRange.start)
            && Number.isFinite(requestedRange.end)
            && requestedRange.start <= requestedRange.end
        ) {
            return requestedRange;
        }
        return {
            start: options.currentPage.value,
            end: options.currentPage.value,
        };
    }

    function isPageInProtectedVisibleRange(pageNumber: number) {
        const range = getProtectedVisibleRange();
        return pageNumber >= range.start && pageNumber <= range.end;
    }

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
        cancelObsoleteInFlightRenders,
        getTrackedPageNumbersForCleanup,
        reservePendingPageCanvasSurface,
        reservePageCanvasSurface,
        replacePageCanvasSurfaceLease,
        markPageCanvasSurfaceEvictable,
        releasePageCanvasSurface,
        setPageCanvasSurfacePriority,
        releaseAllSurfaceResources,
    } = usePdfRendererPageRegistry({
        isPageProtected: isPageInProtectedVisibleRange,
        onPageEvicted: (pageNumber) => {
            handlePageSurfaceEvicted(pageNumber);
        },
    });

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
        releasePageCanvasSurface,
        releaseAllSurfaceResources,
        onRenderedPageStateChanged: options.onRenderedPageStateChanged,
        invalidatePendingSearchRequests: searchController.invalidatePendingRequests,
    });
    handlePageSurfaceEvicted = (pageNumber) => {
        // Budget eviction must be a coherent visual-state transition. A zeroed
        // backing store cannot remain mounted or classified as ready.
        clearPageVisual(pageNumber, false);
        options.onRenderedPageStateChanged?.();
    };

    function reconcilePageCanvasResidency(
        residentPageNumbers: readonly number[],
        visibleRange: IPageRange,
    ) {
        const residentPages = new Set(residentPageNumbers);
        let didChangeRenderedState = false;
        for (const pageNumber of getTrackedPageNumbersForCleanup()) {
            if (residentPages.has(pageNumber)) {
                const distance = pageNumber < visibleRange.start
                    ? visibleRange.start - pageNumber
                    : pageNumber > visibleRange.end
                        ? pageNumber - visibleRange.end
                        : 0;
                setPageCanvasSurfacePriority(pageNumber, distance === 0 ? 90 : Math.max(40, 70 - distance));
                continue;
            }
            cancelActiveRenderTask(pageNumber);
            cancelActiveTextLayerRender(pageNumber);
            renderingPages.delete(pageNumber);
            renderingPageRequestIds.delete(pageNumber);
            missingRenderTargetRetries.delete(pageNumber);
            didChangeRenderedState = clearPageVisual(pageNumber, false) || didChangeRenderedState;
        }
        if (didChangeRenderedState) {
            options.onRenderedPageStateChanged?.();
        }
    }
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
        reservePendingPageCanvasSurface,
        reservePageCanvasSurface,
        replacePageCanvasSurfaceLease,
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
        markPageCanvasSurfaceEvictable,
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

    const visibleRenderController = usePdfRendererVisibleRenderController({
        container: options.container,
        currentPage: options.currentPage,
        numPages,
        isActive,
        bufferPages,
        renderConcurrency,
        effectiveScale: options.effectiveScale,
        renderedPages,
        renderingPages,
        renderingPageRequestIds,
        getRenderVersion: () => renderVersion,
        getRenderDocumentToken,
        getVisibleRenderRequestId: () => visibleRenderRequestId,
        nextVisibleRenderRequestId: () => {
            visibleRenderRequestId += 1;
            return visibleRenderRequestId;
        },
        setVisibleRenderRequestId: (requestId) => {
            visibleRenderRequestId = requestId;
            return visibleRenderRequestId;
        },
        isRenderRequestCurrent: options.isRenderRequestCurrent,
        ensurePageMetricsInRange,
        setupPagePlaceholders,
        cleanupPage,
        cancelObsoleteInFlightRenders: (pagesToKeepRendering, requestId) => {
            cancelObsoleteInFlightRenders(
                pagesToKeepRendering,
                requestId,
                cleanupPageIfCurrentRender,
            );
        },
        renderSingleVisiblePage,
        isVisibleRenderRangeCurrent: options.isVisibleRenderRangeCurrent,
        scheduleMissingRenderTargetRetry,
        throttleMs: RERENDER_LOG_THROTTLE_MS,
    });

    function renderVisiblePages(
        range: IPageRange,
        renderOptions?: IRenderVisiblePagesOptions,
    ) {
        const resolvedRenderOptions = bindPdfOpenSurfaceRenderContext(
            renderOptions,
            options.resolveOpenSurfaceRenderContext?.(),
        );
        return visibleRenderController(range, resolvedRenderOptions);
    }

    function hasNonzeroMountedPageCanvas(pageNumber: number) {
        const pageContainer = getMountedPageContainer(pageNumber, options.container.value);
        const canvas = pageContainer?.querySelector<HTMLCanvasElement>('.page_canvas canvas');
        return Boolean(canvas && canvas.isConnected && canvas.width > 0 && canvas.height > 0);
    }

    function renderTransactionPages(request: IPdfViewerTransactionRenderRequest) {
        return visibleRenderController.renderTransactionPages(request);
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
        const activeRenderTasksSettled = waitForActiveRenderTasksToSettle();
        const optionalTextLayerTasksSettled = waitForOptionalTextLayerTasksToSettle();
        bumpRenderVersion('cancel-in-flight-renders');
        missingRenderTargetRetries.clear();
        return Promise.all([
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
        reconcilePageCanvasResidency,
        renderTransactionPages,
        reRenderAllVisiblePages,
        cleanupAllPages,
        releaseUnmountedPage: cleanupPage,
        invalidatePages,
        applySearchHighlights,
        hideManagedAnnotationEditors: (pageNumber?: number) => {
            annotationLayerRenderer.hideHiddenManagedEditors(pageNumber);
        },
        isPageRendered: (pageNumber: number) => pageRenderState.getSlot(pageNumber).visual === 'ready',
        isPageFreshlyRendered: (pageNumber: number) => pageRenderState.getSlot(pageNumber).visual === 'ready',
        isPageCanvasCommitted: (pageNumber: number) => {
            const slot = pageRenderState.getSlot(pageNumber);
            const currentScale = toValue(options.effectiveScale);
            const currentOutputScale = toValue(outputScale);
            const scaleTolerance = Math.max(1, Math.abs(currentScale)) * Number.EPSILON * 8;
            const outputScaleTolerance = Math.max(1, Math.abs(currentOutputScale)) * Number.EPSILON * 8;
            return (
                slot.visual === 'ready'
                && slot.documentToken === getRenderDocumentToken()
                && slot.targetScale !== null
                && Math.abs(slot.targetScale - currentScale) <= scaleTolerance
                && slot.targetOutputScale !== null
                && Math.abs(slot.targetOutputScale - currentOutputScale) <= outputScaleTolerance
                && hasNonzeroMountedPageCanvas(pageNumber)
            );
        },
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
        requestScrollToCurrentResult,
        cancelPendingSearchScroll: searchController.invalidatePendingRequests,
        cancelInFlightRenders,
        renderAnnotationEditorLayerForPage,
    };
};
