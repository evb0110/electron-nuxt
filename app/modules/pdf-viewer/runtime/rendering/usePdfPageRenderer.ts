import { Mutex } from 'es-toolkit';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type {
    IPdfPageMatches,
    IPdfPageMetric,
    IPdfSearchMatch,
} from '@app/types/pdf';
import type { IPdfjsL10n } from '@app/types/pdfjs';
import type { TDocumentRef } from '@contracts/documentRef';
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
import { clearPdfSelectionForLayerTeardown } from '@app/modules/pdf-viewer/engine/pdf-selection-cleanup/clearPdfSelectionForLayerTeardown';
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

export type { IPageRenderStallPayload } from '@app/modules/pdf-viewer/engine/pdf-page-render-timeout/pdfPageRenderTimeoutTypes';

const MAX_MISSING_RENDER_TARGET_RETRIES = 4;

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
    endSearchNavigation?: (settleMs?: number) => void;
    outputScale?: number;

    annotationUiManager?: MaybeRefOrGetter<AnnotationEditorUIManager | null>;
    annotationL10n?: MaybeRefOrGetter<IPdfjsL10n | null>;

    searchPageMatches?: MaybeRefOrGetter<Map<number, IPdfPageMatches>>;
    currentSearchMatch?: MaybeRefOrGetter<IPdfSearchMatch | null>;
    currentSearchMatchNavigationId?: MaybeRefOrGetter<number>;

    workingCopyPath?: MaybeRefOrGetter<TDocumentRef | null>;
    onRenderStall?: (payload: IPageRenderStallPayload) => void;
    onPageRendered?: (pageNumber: number) => void;
    onPageCanvasMounted?: (pageNumber: number) => void;
    onAnnotationLayersRendered?: ((pageNumber: number, container: HTMLElement) => void) | undefined;
    onRenderedPageStateChanged?: () => void;
}

export const usePdfPageRenderer = (options: IUsePdfPageRendererOptions) => {
    const performanceProfile = getPerformanceProfile();
    const {
        pdfDocument,
        numPages,
        basePageWidth,
        basePageHeight,
        isLoading,
        getPage,
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
        effectiveScale: options.effectiveScale,
    });
    const annotationLayerRenderer = usePdfAnnotationLayerRenderer({
        numPages,
        currentPage: options.currentPage,
        pdfDocument,
        showAnnotations,
        hiddenAnnotationIds: options.hiddenAnnotationIds ?? new Set<string>(),
        managedAnnotationIds: options.managedAnnotationIds ?? new Set<string>(),
        annotationUiManager: options.annotationUiManager ?? null,
        annotationL10n: options.annotationL10n ?? null,
        ...(options.scrollToPage ? { scrollToPage: options.scrollToPage } : {}),
    });

    const renderMutex = new Mutex();
    const RERENDER_LOG_THROTTLE_MS = 420;
    let renderVersion = 0;
    let visibleRenderRequestId = 0;

    const {
        renderedPages,
        staleRenderedPages,
        renderingPages,
        renderingPageRequestIds,
        activeRenderTasks,
        missingRenderTargetRetries,
        pageCanvases,
        textLayerCleanupFns,
        activeTextLayerAbortControllers,
        cancelActiveRenderTask,
        cancelActiveRenderTaskIfCurrent,
        cancelAllActiveRenderTasks,
        cancelActiveTextLayerRender,
        cancelActiveTextLayerRenderIfCurrent,
        cancelAllActiveTextLayerRenders,
        cancelObsoleteInFlightRenders,
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
        staleRenderedPages,
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
            renderedPages: Array.from(renderedPages),
            staleRenderedPages: Array.from(staleRenderedPages),
            renderingPages: Array.from(renderingPages.entries()),
            renderingPageRequestIds: Array.from(renderingPageRequestIds.entries()),
            ...payload,
        });
        cancelAllActiveRenderTasks();
        cancelAllActiveTextLayerRenders();
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

    function scheduleRenderForSinglePage(
        pageNumber: number,
        optionsOverride: {
            preserveRenderedPages?: boolean;
            bufferOverride?: number;
        },
    ) {
        runGuardedTask(
            () =>
                renderVisiblePages(
                    {
                        start: pageNumber,
                        end: pageNumber,
                    },
                    optionsOverride,
                ),
            {
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
    ) {
        if (
            !shouldRetry
            || renderVersion !== version
            || requestId !== visibleRenderRequestId
        ) {
            return;
        }

        const retryCount = missingRenderTargetRetries.get(pageNumber) ?? 0;
        if (retryCount >= MAX_MISSING_RENDER_TARGET_RETRIES) {
            clearPdfSelectionForLayerTeardown({
                root: options.container.value,
                includeDetached: true,
                includeAnyPdfTextSelection: true,
            });
            BrowserLogger.warnThrottled(
                'pdf-renderer',
                `missing-render-target-retry-exhausted:${pageNumber}`,
                RERENDER_LOG_THROTTLE_MS,
                `Exhausted render retries waiting for page ${pageNumber} container`,
                {
                    pageNumber,
                    version,
                    renderVersion,
                    currentPage: options.currentPage.value,
                },
            );
            return;
        }

        missingRenderTargetRetries.set(pageNumber, retryCount + 1);
        const retry = () => {
            if (renderVersion !== version || requestId !== visibleRenderRequestId) {
                return;
            }

            scheduleRenderForSinglePage(pageNumber, {
                preserveRenderedPages: true,
                bufferOverride: 0,
            });
        };

        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
            window.requestAnimationFrame(() => retry());
            return;
        }

        setTimeout(retry, 0);
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
            });
        },
        ...(options.scrollToPage ? { scrollToPage: options.scrollToPage } : {}),
        ...(options.suppressSnap ? { suppressSnap: options.suppressSnap } : {}),
        ...(options.beginSearchNavigation ? { beginSearchNavigation: options.beginSearchNavigation } : {}),
        ...(options.endSearchNavigation ? { endSearchNavigation: options.endSearchNavigation } : {}),
    });

    const {
        cleanupTextLayer,
        cleanupPage,
        cleanupPageIfCurrentRender,
        cleanupAllPages,
    } = usePdfRendererCleanupController({
        container: options.container,
        currentPage: options.currentPage,
        renderedPages,
        staleRenderedPages,
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
    const {
        releasePageResources,
        loadPageForRender,
        prepareCanvasForRender,
        mountRenderedCanvas,
    } = usePdfRendererCanvasController({
        canvasRenderer,
        activeRenderTasks,
        pageCanvases,
        hiddenAnnotationIds: () => toValue(options.canvasHiddenAnnotationIds ?? options.hiddenAnnotationIds),
        getRenderVersion: () => renderVersion,
        getPage,
        cancelActiveRenderTask,
        cancelActiveRenderTaskIfCurrent,
        onRenderStall: options.onRenderStall,
    });
    type TCanvasRenderResult = NonNullable<Awaited<ReturnType<typeof prepareCanvasForRender>>>;
    const { renderAnnotationLayersForPage } = usePdfRendererAnnotationLayerController({
        annotationLayerRenderer,
        showAnnotations,
        annotationUiManager: options.annotationUiManager ?? null,
        getRenderVersion: () => renderVersion,
        cleanupPageIfCurrentRender,
        logNonCriticalStageError,
        onAnnotationLayersRendered: options.onAnnotationLayersRendered,
    });
    const { renderTextLayerForPage } = usePdfRendererTextLayerController({
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
        onRenderStall: options.onRenderStall,
    });
    const {
        renderSingleVisiblePage,
        renderAnnotationEditorLayerForPage,
    } = usePdfRendererSinglePageController<TCanvasRenderResult>({
        isActive,
        effectiveScale: options.effectiveScale,
        annotationUiManager: options.annotationUiManager ?? null,
        getContainerRoot: () => options.container.value,
        renderedPages,
        staleRenderedPages,
        renderingPages,
        renderingPageRequestIds,
        activeRenderTasks,
        getRenderVersion: () => renderVersion,
        getVisibleRenderRequestId: () => visibleRenderRequestId,
        summarizePageDom,
        clearSelectionBeforePageLayerTeardown,
        cleanupPageIfCurrentRender,
        cleanupCanvasRenderResult: canvasRenderer.cleanupCanvasRenderResult,
        releasePageResources,
        loadPageForRender,
        prepareCanvasForRender,
        mountRenderedCanvas,
        scheduleRenderForSinglePage,
        scheduleMissingRenderTargetRetry,
        clearMissingRenderTargetRetry: (pageNumber) => {
            missingRenderTargetRetries.delete(pageNumber);
        },
        renderTextLayerForPage,
        renderAnnotationLayersForPage,
        renderAnnotationEditorLayer: annotationLayerRenderer.renderAnnotationEditorLayer,
        getViewportForAnnotationEditorLayer: (pdfPage, scale) => pdfPage.getViewport({ scale }),
        scheduleOcrDebugForPage: (pageNumber, context) => {
            textLayerRenderer.scheduleOcrDebugForPage?.(pageNumber, context);
        },
        onPageCanvasMounted: options.onPageCanvasMounted,
        onPageRendered: options.onPageRendered,
        onRenderedPageStateChanged: options.onRenderedPageStateChanged,
        logNonCriticalStageError,
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

    const { renderVisiblePages } = usePdfRendererVisibleRenderController({
        container: options.container,
        currentPage: options.currentPage,
        numPages,
        isActive,
        bufferPages,
        renderConcurrency,
        effectiveScale: options.effectiveScale,
        renderedPages,
        staleRenderedPages,
        renderingPages,
        renderingPageRequestIds,
        getRenderVersion: () => renderVersion,
        getVisibleRenderRequestId: () => visibleRenderRequestId,
        nextVisibleRenderRequestId: () => {
            visibleRenderRequestId += 1;
            return visibleRenderRequestId;
        },
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
        scheduleMissingRenderTargetRetry,
        throttleMs: RERENDER_LOG_THROTTLE_MS,
    });

    const { reRenderAllVisiblePages } = usePdfRendererRerenderController({
        container: options.container,
        currentPage: options.currentPage,
        numPages,
        isActive,
        renderedPages,
        staleRenderedPages,
        pageCanvases,
        renderMutex,
        getRenderVersion: () => renderVersion,
        bumpRenderVersion,
        setupPagePlaceholders,
        renderVisiblePages,
        getTrackedPageNumbersForCleanup,
        cleanupPage,
        throttleMs: RERENDER_LOG_THROTTLE_MS,
    });

    const { applySearchHighlights } = searchController;

    function invalidatePages(pages: number[]) {
        bumpRenderVersion('invalidate-pages', { pages });
        logPdfRenderTrace('renderer-invalidate-pages', {
            pages,
            currentPage: options.currentPage.value,
            visiblePages: pages.map(pageNumber => summarizePageDom(pageNumber)),
        });
        for (const pageNumber of pages) {
            cleanupPage(pageNumber);
        }
    }

    function cancelInFlightRenders() {
        bumpRenderVersion('cancel-in-flight-renders');
        missingRenderTargetRetries.clear();
    }

    const { requestScrollToCurrentResult } = searchController;

    return {
        setupPagePlaceholders,
        renderVisiblePages,
        reRenderAllVisiblePages,
        cleanupAllPages,
        invalidatePages,
        applySearchHighlights,
        hideManagedAnnotationEditors: (pageNumber?: number) => {
            annotationLayerRenderer.hideHiddenManagedEditors(pageNumber);
        },
        isPageRendered: (pageNumber: number) => renderedPages.has(pageNumber),
        isPageRendering: (pageNumber: number) => renderingPages.has(pageNumber),
        requestScrollToCurrentResult,
        cancelPendingSearchScroll: searchController.invalidatePendingRequests,
        cancelInFlightRenders,
        renderAnnotationEditorLayerForPage,
    };
};
