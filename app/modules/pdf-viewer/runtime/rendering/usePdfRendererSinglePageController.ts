import type { IRenderVisiblePagesOptions } from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';
import type { IPageRange } from '@app/types/pdf';
import type { MaybeRefOrGetter } from 'vue';
import type { PDFPageProxy } from 'pdfjs-dist';
import { getPageContainer } from '@app/modules/pdf-viewer/engine/pdf-page-buffer-manager/getPageContainer';
import { formatRenderError } from '@app/modules/pdf-viewer/engine/pdf-page-render-pipeline/formatRenderError';
import { isRenderingCancelledError } from '@app/modules/pdf-viewer/engine/pdf-page-render-pipeline/isRenderingCancelledError';
import { isPageRenderTimeoutError } from '@app/modules/pdf-viewer/engine/pdf-page-render-timeout/isPageRenderTimeoutError';
import type { IPageRenderTimeoutError } from '@app/modules/pdf-viewer/engine/pdf-page-render-timeout/pdfPageRenderTimeoutTypes';
import { pdfViewerDomClasses } from '@app/modules/pdf-viewer/dom/pdf-viewer-dom/pdfViewerDomClasses';
import { BrowserLogger } from '@app/utils/browserLogger';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';


interface ISinglePageRenderTarget {
    container: HTMLElement;
    canvasHost: HTMLDivElement;
}

interface IRenderPageContext<TRenderResult> {
    container: HTMLElement;
    pdfPage: PDFPageProxy;
    renderResult: TRenderResult;
    textLayerDiv: HTMLDivElement | null;
    annotationLayerInstance: unknown;
}

interface IUsePdfRendererSinglePageControllerOptions<TRenderResult> {
    isActive: MaybeRefOrGetter<boolean>;
    effectiveScale: MaybeRefOrGetter<number>;
    annotationUiManager: MaybeRefOrGetter<unknown>;
    getContainerRoot: () => HTMLElement | null;
    renderedPages: Set<number>;
    staleRenderedPages: Set<number>;
    renderingPages: Map<number, number>;
    renderingPageRequestIds: Map<number, number>;
    activeRenderTasks: Map<number, {
        version: number;
        requestId: number;
        task: unknown;
    }>;
    getRenderVersion: () => number;
    getVisibleRenderRequestId: () => number;
    summarizePageDom: (pageNumber: number) => Record<string, unknown>;
    clearSelectionBeforePageLayerTeardown: (pageNumber: number) => unknown;
    cleanupPageIfCurrentRender: (pageNumber: number, version: number, requestId?: number) => void;
    cleanupCanvasRenderResult: (renderResult: TRenderResult) => void;
    releasePageResources: (pageNumber: number, pdfPage: PDFPageProxy) => void;
    loadPageForRender: (
        pageNumber: number,
        version: number,
        shouldContinue: () => boolean,
    ) => Promise<PDFPageProxy | null>;
    prepareCanvasForRender: (
        pdfPage: PDFPageProxy,
        pageNumber: number,
        version: number,
        requestId: number,
        scale: number,
        shouldContinue: () => boolean,
        renderOptions?: IRenderVisiblePagesOptions,
    ) => Promise<TRenderResult | null>;
    mountRenderedCanvas: (
        pageNumber: number,
        container: HTMLElement,
        canvasHost: HTMLDivElement,
        renderResult: TRenderResult,
        scale: number,
    ) => void;
    scheduleRenderForSinglePage: (
        pageNumber: number,
        optionsOverride: {
            preserveRenderedPages?: boolean;
            bufferOverride?: number;
        },
    ) => void;
    scheduleMissingRenderTargetRetry: (
        pageNumber: number,
        version: number,
        requestId: number,
        shouldRetry: boolean,
        visibleRange: IPageRange,
    ) => void;
    clearMissingRenderTargetRetry: (pageNumber: number) => void;
    renderTextLayerForPage: (
        pageNumber: number,
        version: number,
        requestId: number,
        context: IRenderPageContext<TRenderResult>,
        scale: number,
        shouldContinue: () => boolean,
    ) => Promise<boolean>;
    renderAnnotationLayersForPage: (
        pageNumber: number,
        version: number,
        requestId: number,
        context: IRenderPageContext<TRenderResult>,
        shouldContinue: () => boolean,
    ) => Promise<{
        shouldContinue: boolean;
        annotationLayerInstance: unknown;
    }>;
    renderAnnotationEditorLayer: (
        container: HTMLElement,
        annotationEditorLayerDiv: HTMLElement,
        textLayerDiv: HTMLDivElement | null,
        viewport: ReturnType<PDFPageProxy['getViewport']>,
        pageNumber: number,
        annotationLayerInstance: null,
        options?: { shouldContinue?: () => boolean },
    ) => Promise<unknown>;
    getViewportForAnnotationEditorLayer: (pdfPage: PDFPageProxy, scale: number) => ReturnType<PDFPageProxy['getViewport']>;
    scheduleOcrDebugForPage: (pageNumber: number, context: IRenderPageContext<TRenderResult>) => void;
    onPageCanvasMounted?: ((pageNumber: number) => void) | undefined;
    onPageRendered?: ((pageNumber: number) => void) | undefined;
    onRenderedPageStateChanged?: (() => void) | undefined;
    logNonCriticalStageError: (pageNumber: number, stage: string, error: unknown) => void;
}

export function usePdfRendererSinglePageController<TRenderResult>(
    options: IUsePdfRendererSinglePageControllerOptions<TRenderResult>,
) {
    const {
        isActive,
        effectiveScale,
        annotationUiManager: annotationUiManagerRef,
        getContainerRoot,
        renderedPages,
        staleRenderedPages,
        renderingPages,
        renderingPageRequestIds,
        activeRenderTasks,
        getRenderVersion,
        getVisibleRenderRequestId,
        summarizePageDom,
        clearSelectionBeforePageLayerTeardown,
        cleanupPageIfCurrentRender,
        cleanupCanvasRenderResult,
        releasePageResources,
        loadPageForRender,
        prepareCanvasForRender,
        mountRenderedCanvas,
        scheduleRenderForSinglePage,
        scheduleMissingRenderTargetRetry,
        clearMissingRenderTargetRetry,
        renderTextLayerForPage,
        renderAnnotationLayersForPage,
        renderAnnotationEditorLayer,
        getViewportForAnnotationEditorLayer,
        scheduleOcrDebugForPage,
        onPageCanvasMounted,
        onPageRendered,
        onRenderedPageStateChanged,
        logNonCriticalStageError,
    } = options;

    function cleanupStaleMountedPageRender(
        pageNumber: number,
        version: number,
        requestId: number,
        pdfPage: PDFPageProxy,
    ) {
        cleanupPageIfCurrentRender(pageNumber, version, requestId);
        releasePageResources(pageNumber, pdfPage);
    }

    function finalizePageRender(
        pageNumber: number,
        version: number,
        pdfPage: PDFPageProxy,
        pageContainer: HTMLElement,
        shouldContinue: () => boolean,
    ) {
        if (getRenderVersion() !== version || !shouldContinue()) {
            logPdfRenderTrace('renderer-finalize-page-skip-stale', {
                pageNumber,
                version,
                renderVersion: getRenderVersion(),
                pageBeforeSkip: summarizePageDom(pageNumber),
            });
            return false;
        }

        releasePageResources(pageNumber, pdfPage);
        renderedPages.add(pageNumber);
        staleRenderedPages.delete(pageNumber);
        pageContainer.classList.add(pdfViewerDomClasses.renderedPageContainer);
        logPdfRenderTrace('renderer-finalize-page', {
            pageNumber,
            version,
            renderVersion: getRenderVersion(),
            pageBeforeNotify: summarizePageDom(pageNumber),
        });
        onPageRendered?.(pageNumber);
        onRenderedPageStateChanged?.();
        return true;
    }

    function shouldSkipSingleVisiblePageRender(
        pageNumber: number,
        version: number,
        forceRerender: boolean,
        target: ISinglePageRenderTarget,
        requestId: number,
    ) {
        if (getRenderVersion() !== version) {
            return true;
        }

        if (renderingPages.get(pageNumber) === version) {
            return renderingPageRequestIds.get(pageNumber) === requestId;
        }

        if (renderedPages.has(pageNumber)) {
            const isStaleRender = staleRenderedPages.has(pageNumber);
            const hasMountedCanvas = Boolean(
                target.container.querySelector<HTMLCanvasElement>('.page_canvas canvas'),
            );
            if (!forceRerender && !isStaleRender && hasMountedCanvas) {
                return true;
            }
        }

        return false;
    }

    function getSinglePageRenderTarget(
        containerRoot: HTMLElement,
        pageNumber: number,
    ): ISinglePageRenderTarget | null {
        const container = getPageContainer(containerRoot, pageNumber - 1);
        if (!container) {
            return null;
        }

        const canvasHost =
            container.querySelector<HTMLDivElement>('.page_canvas');
        if (!canvasHost) {
            return null;
        }

        return {
            container,
            canvasHost,
        };
    }

    async function mountSingleVisiblePageLayers(
        pageNumber: number,
        version: number,
        scale: number,
        target: ISinglePageRenderTarget,
        pdfPage: PDFPageProxy,
        renderResult: TRenderResult | null,
        requestId: number,
        shouldContinue: () => boolean,
    ) {
        if (!renderResult) {
            return;
        }

        if (getRenderVersion() !== version || !shouldContinue()) {
            cleanupCanvasRenderResult(renderResult);
            releasePageResources(pageNumber, pdfPage);
            return;
        }
        if (!isCurrentMountedRenderTarget(pageNumber, version, target, shouldContinue)) {
            cleanupCanvasRenderResult(renderResult);
            releasePageResources(pageNumber, pdfPage);
            clearSinglePageRenderTracking(pageNumber, version, requestId);
            return;
        }

        mountRenderedCanvas(pageNumber, target.container, target.canvasHost, renderResult, scale);
        logPdfRenderTrace('renderer-canvas-mounted', {
            pageNumber,
            version,
            requestId,
            page: summarizePageDom(pageNumber),
        });
        onPageCanvasMounted?.(pageNumber);

        const textLayerDiv =
            target.container.querySelector<HTMLDivElement>('.text-layer');
        const renderContext: IRenderPageContext<TRenderResult> = {
            container: target.container,
            pdfPage,
            renderResult,
            textLayerDiv,
            annotationLayerInstance: null,
        };
        const shouldContinueAfterTextLayer = await renderTextLayerForPage(
            pageNumber,
            version,
            requestId,
            renderContext,
            scale,
            shouldContinue,
        );
        if (!shouldContinueAfterTextLayer) {
            cleanupStaleMountedPageRender(pageNumber, version, requestId, pdfPage);
            return;
        }
        if (!shouldContinue()) {
            cleanupStaleMountedPageRender(pageNumber, version, requestId, pdfPage);
            return;
        }

        const annotationRenderResult = await renderAnnotationLayersForPage(
            pageNumber,
            version,
            requestId,
            renderContext,
            shouldContinue,
        );
        if (!annotationRenderResult.shouldContinue) {
            cleanupStaleMountedPageRender(pageNumber, version, requestId, pdfPage);
            return;
        }
        if (!shouldContinue()) {
            cleanupStaleMountedPageRender(pageNumber, version, requestId, pdfPage);
            return;
        }

        renderContext.annotationLayerInstance =
            annotationRenderResult.annotationLayerInstance;
        scheduleOcrDebugForPage(pageNumber, renderContext);
        finalizePageRender(pageNumber, version, pdfPage, target.container, shouldContinue);
    }

    function scheduleCancelledPageRenderRetry(
        pageNumber: number,
        version: number,
        requestId: number,
    ) {
        if (getRenderVersion() !== version || requestId !== getVisibleRenderRequestId()) {
            logPdfRenderTrace('renderer-cancelled-page-retry-skip-stale', {
                pageNumber,
                version,
                requestId,
                currentRenderVersion: getRenderVersion(),
                activeRequestId: getVisibleRenderRequestId(),
            });
            return;
        }

        setTimeout(() => {
            if (getRenderVersion() !== version || requestId !== getVisibleRenderRequestId()) {
                logPdfRenderTrace('renderer-cancelled-page-retry-skip-timeout-stale', {
                    pageNumber,
                    version,
                    requestId,
                    currentRenderVersion: getRenderVersion(),
                    activeRequestId: getVisibleRenderRequestId(),
                });
                return;
            }
            scheduleRenderForSinglePage(pageNumber, {
                preserveRenderedPages: true,
                bufferOverride: 0,
            });
        }, 0);
    }

    function logPageRenderTimeout(error: IPageRenderTimeoutError, version: number) {
        BrowserLogger.warn(
            'pdf-renderer',
            `Timed out waiting for ${error.stage} on page ${error.pageNumber}`,
            {
                pageNumber: error.pageNumber,
                stage: error.stage,
                timeoutMs: error.timeoutMs,
                renderVersion: version,
                currentRenderVersion: getRenderVersion(),
            },
        );
    }

    function handleSinglePageRenderError(
        pageNumber: number,
        error: unknown,
        version: number,
        requestId: number,
    ) {
        if (isRenderingCancelledError(error)) {
            scheduleCancelledPageRenderRetry(pageNumber, version, requestId);
            return;
        }

        if (isPageRenderTimeoutError(error)) {
            logPageRenderTimeout(error, version);
            cleanupPageIfCurrentRender(pageNumber, version, requestId);
            return;
        }

        BrowserLogger.error(
            'pdf-renderer',
            formatRenderError(error, pageNumber),
        );
        cleanupPageIfCurrentRender(pageNumber, version, requestId);
    }

    function clearSinglePageRenderTracking(
        pageNumber: number,
        version: number,
        requestId?: number,
    ) {
        if (
            requestId !== undefined
            && renderingPageRequestIds.get(pageNumber) !== requestId
        ) {
            return;
        }
        const activeRenderTask = activeRenderTasks.get(pageNumber);
        if (
            activeRenderTask
            && activeRenderTask.version === version
            && (
                requestId === undefined
                || activeRenderTask.requestId === requestId
            )
        ) {
            activeRenderTasks.delete(pageNumber);
        }
        if (renderingPages.get(pageNumber) === version) {
            renderingPages.delete(pageNumber);
            renderingPageRequestIds.delete(pageNumber);
        }
    }

    function isCurrentMountedRenderTarget(
        pageNumber: number,
        version: number,
        target: ISinglePageRenderTarget,
        shouldContinue: () => boolean,
    ) {
        if (
            getRenderVersion() !== version
            || renderingPages.get(pageNumber) !== version
            || !shouldContinue()
        ) {
            return false;
        }
        if (target.container.isConnected === false || target.canvasHost.isConnected === false) {
            return false;
        }
        if (target.container.dataset.page !== String(pageNumber)) {
            return false;
        }
        if (
            typeof target.canvasHost.closest === 'function'
            && target.canvasHost.closest('.page_container') !== target.container
        ) {
            return false;
        }
        return true;
    }

    async function renderSingleVisiblePage(
        containerRoot: HTMLElement,
        pageNumber: number,
        version: number,
        scale: number,
        forceRerender: boolean,
        requestId: number,
        shouldContinue: () => boolean,
        requiredPages: Set<number>,
        visibleRange: IPageRange,
        renderOptions?: IRenderVisiblePagesOptions,
    ) {
        const shouldContinuePage = () => (
            shouldContinue()
            && renderingPages.get(pageNumber) === version
            && renderingPageRequestIds.get(pageNumber) === requestId
        );
        const target = getSinglePageRenderTarget(containerRoot, pageNumber);
        if (!target) {
            logPdfRenderTrace('renderer-single-page-missing-target', {
                pageNumber,
                version,
                requestId,
                required: requiredPages.has(pageNumber),
            });
            scheduleMissingRenderTargetRetry(
                pageNumber,
                version,
                requestId,
                requiredPages.has(pageNumber),
                visibleRange,
            );
            return;
        }
        clearMissingRenderTargetRetry(pageNumber);

        if (shouldSkipSingleVisiblePageRender(pageNumber, version, forceRerender, target, requestId)) {
            logPdfRenderTrace('renderer-single-page-skip', {
                pageNumber,
                version,
                requestId,
                forceRerender,
                page: summarizePageDom(pageNumber),
            });
            return;
        }

        logPdfRenderTrace('renderer-single-page-begin', {
            pageNumber,
            version,
            requestId,
            forceRerender,
            scale,
            page: summarizePageDom(pageNumber),
        });
        renderingPages.set(pageNumber, version);
        renderingPageRequestIds.set(pageNumber, requestId);
        clearSelectionBeforePageLayerTeardown(pageNumber);
        try {
            logPdfRenderTrace('renderer-page-load-begin', {
                pageNumber,
                version,
                requestId,
            });
            const pdfPage = await loadPageForRender(pageNumber, version, shouldContinuePage);
            if (!pdfPage) {
                logPdfRenderTrace('renderer-page-load-stale', {
                    pageNumber,
                    version,
                    requestId,
                    renderVersion: getRenderVersion(),
                });
                return;
            }
            logPdfRenderTrace('renderer-page-load-end', {
                pageNumber,
                version,
                requestId,
            });
            if (!shouldContinuePage()) {
                logPdfRenderTrace('renderer-page-load-skip-stale', {
                    pageNumber,
                    version,
                    requestId,
                    renderVersion: getRenderVersion(),
                });
                releasePageResources(pageNumber, pdfPage);
                return;
            }
            logPdfRenderTrace('renderer-canvas-prepare-begin', {
                pageNumber,
                version,
                requestId,
                scale,
            });
            const renderResult = await prepareCanvasForRender(
                pdfPage,
                pageNumber,
                version,
                requestId,
                scale,
                shouldContinuePage,
                renderOptions,
            );
            if (!renderResult) {
                logPdfRenderTrace('renderer-canvas-prepare-stale', {
                    pageNumber,
                    version,
                    requestId,
                    renderVersion: getRenderVersion(),
                });
                releasePageResources(pageNumber, pdfPage);
                return;
            }
            logPdfRenderTrace('renderer-canvas-prepare-end', {
                pageNumber,
                version,
                requestId,
            });
            await mountSingleVisiblePageLayers(
                pageNumber,
                version,
                scale,
                target,
                pdfPage,
                renderResult,
                requestId,
                shouldContinuePage,
            );
        } catch (error) {
            logPdfRenderTrace('renderer-single-page-error', {
                pageNumber,
                version,
                requestId,
                errorName: error instanceof Error ? error.name : null,
                errorMessage: error instanceof Error ? error.message : String(error),
            });
            handleSinglePageRenderError(pageNumber, error, version, requestId);
        } finally {
            clearSinglePageRenderTracking(pageNumber, version, requestId);
            logPdfRenderTrace('renderer-single-page-end', {
                pageNumber,
                version,
                requestId,
                page: summarizePageDom(pageNumber),
            });
        }
    }

    return {
        renderSingleVisiblePage,
        renderAnnotationEditorLayerForPage: async (pageNumber: number) => {
            if (!toValue(isActive)) {
                return false;
            }
            const containerRoot = getContainerRoot();
            const annotationUiManager = toValue(annotationUiManagerRef) ?? null;
            if (!containerRoot || !annotationUiManager) {
                return false;
            }
            const target = getSinglePageRenderTarget(containerRoot, pageNumber);
            if (!target) {
                return false;
            }
            const version = getRenderVersion();
            const pdfPage = await loadPageForRender(
                pageNumber,
                version,
                () => getRenderVersion() === version,
            );
            if (!pdfPage) {
                return false;
            }
            try {
                const shouldContinueEditorLayerRender = () => (
                    getRenderVersion() === version
                    && toValue(isActive)
                    && target.container.isConnected !== false
                    && target.canvasHost.isConnected !== false
                    && target.container.dataset.page === String(pageNumber)
                );
                if (!shouldContinueEditorLayerRender()) {
                    return false;
                }
                const textLayerDiv =
                    target.container.querySelector<HTMLDivElement>('.text-layer');
                const annotationEditorLayerDiv =
                    target.container.querySelector<HTMLElement>('.annotation-editor-layer');
                if (!annotationEditorLayerDiv) {
                    return false;
                }
                const viewport = getViewportForAnnotationEditorLayer(pdfPage, toValue(effectiveScale));
                await renderAnnotationEditorLayer(
                    target.container,
                    annotationEditorLayerDiv,
                    textLayerDiv,
                    viewport,
                    pageNumber,
                    null,
                    { shouldContinue: shouldContinueEditorLayerRender },
                );
                return shouldContinueEditorLayerRender();
            } catch (error) {
                logNonCriticalStageError(
                    pageNumber,
                    'annotation editor layer',
                    error,
                );
                return false;
            } finally {
                releasePageResources(pageNumber, pdfPage);
            }
        },
    };
}
